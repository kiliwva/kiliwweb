package com.kiliw.kid;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextDecoration;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.EntityPickupItemEvent;
import org.bukkit.event.player.AsyncChatEvent;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.event.player.PlayerDropItemEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * K-ID auth for offline-mode Paper servers.
 *
 * On join the player is frozen and receives a one-time K-ID link in
 * chat. Approving the link on id.kiliw.com unfreezes them; a denial
 * or a timeout kicks them. The first approval binds the nickname to
 * the K-ID account, so nobody else can join under it.
 *
 * Premium (Mojang-authenticated) players are skipped when FastLogin
 * is installed: its auto-login marks the session premium before our
 * join handler runs.
 */
public final class KidAuthPlugin extends JavaPlugin implements Listener {

    private final Gson gson = new Gson();
    private final HttpClient http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build();

    /** players currently frozen, with their pending auth session */
    private final Map<UUID, Pending> pending = new ConcurrentHashMap<>();
    /** nick -> last successful auth, for the remember-session grace */
    private final Map<String, Remembered> remembered = new ConcurrentHashMap<>();
    /** premium players marked by FastLogin */
    private final Map<UUID, Boolean> premium = new ConcurrentHashMap<>();

    private String apiUrl;
    private String apiKey;
    private String serverName;
    private int timeoutSeconds;
    private long rememberMillis;

    private record Pending(String token, String poll, BukkitTask pollTask, BukkitTask timeoutTask) { }

    private record Remembered(String address, long until) { }

    @Override
    public void onEnable() {
        saveDefaultConfig();
        apiUrl = getConfig().getString("api-url", "https://id.kiliw.com").replaceAll("/+$", "");
        apiKey = getConfig().getString("api-key", "");
        serverName = getConfig().getString("server-name", "Minecraft server");
        timeoutSeconds = getConfig().getInt("auth-timeout-seconds", 240);
        rememberMillis = getConfig().getLong("remember-hours", 12) * 60L * 60L * 1000L;

        if (apiKey.isBlank()) {
            getLogger().severe("api-key is empty — set it in config.yml (the MC_API_KEY from your Kiliw dashboard).");
        }
        Bukkit.getPluginManager().registerEvents(this, this);
        FastLoginHook.tryRegister(this);
        getLogger().info("K-ID auth enabled, endpoint: " + apiUrl);
    }

    void markPremium(UUID id) {
        premium.put(id, Boolean.TRUE);
    }

    /* ---------- join: freeze and hand out the link ---------- */

    @EventHandler(priority = EventPriority.MONITOR)
    public void onJoin(PlayerJoinEvent event) {
        Player player = event.getPlayer();

        if (premium.remove(player.getUniqueId()) != null) {
            player.sendMessage(Component.text("Licensed account — welcome back!", NamedTextColor.GREEN));
            return;
        }

        Remembered r = remembered.get(player.getName().toLowerCase());
        String address = player.getAddress() != null ? player.getAddress().getAddress().getHostAddress() : "";
        if (r != null && r.until() > System.currentTimeMillis() && r.address().equals(address)) {
            player.sendMessage(Component.text("Session remembered — welcome back!", NamedTextColor.GREEN));
            return;
        }

        freezeAndAuth(player);
    }

    private void freezeAndAuth(Player player) {
        player.setInvulnerable(true);
        player.sendMessage(Component.text("Verifying your K-ID…", NamedTextColor.GRAY));

        Bukkit.getScheduler().runTaskAsynchronously(this, () -> {
            JsonObject res = api("POST", "/api/mc", gson.toJson(Map.of(
                "action", "create",
                "nick", player.getName(),
                "server", serverName
            )), null);
            if (res == null || !res.has("token")) {
                Bukkit.getScheduler().runTask(this, () ->
                    player.kick(Component.text("K-ID auth is unavailable right now. Try again in a minute.")));
                return;
            }
            String token = res.get("token").getAsString();
            String poll = res.get("poll").getAsString();
            String url = res.get("url").getAsString();

            Bukkit.getScheduler().runTask(this, () -> {
                if (!player.isOnline()) return;
                player.sendMessage(Component.empty());
                player.sendMessage(Component.text("Sign in with your K-ID to play:", NamedTextColor.WHITE)
                    .decoration(TextDecoration.BOLD, true));
                player.sendMessage(Component.text(url, NamedTextColor.GOLD)
                    .decoration(TextDecoration.UNDERLINED, true)
                    .clickEvent(ClickEvent.openUrl(url)));
                player.sendMessage(Component.text("The link works once and expires in 5 minutes.", NamedTextColor.GRAY));
                player.sendMessage(Component.empty());

                BukkitTask pollTask = Bukkit.getScheduler().runTaskTimerAsynchronously(this,
                    () -> pollOnce(player, token, poll), 40L, 40L);
                BukkitTask timeoutTask = Bukkit.getScheduler().runTaskLater(this, () -> {
                    Pending p = pending.remove(player.getUniqueId());
                    if (p != null) {
                        p.pollTask().cancel();
                        player.kick(Component.text("K-ID sign-in timed out. Rejoin to try again."));
                    }
                }, timeoutSeconds * 20L);
                pending.put(player.getUniqueId(), new Pending(token, poll, pollTask, timeoutTask));
            });
        });
    }

    private void pollOnce(Player player, String token, String poll) {
        JsonObject res = api("GET", "/api/mc?token=" + token + "&poll=" + poll, null, null);
        if (res == null || !res.has("status")) return;
        String status = res.get("status").getAsString();
        if (status.equals("pending")) return;

        Bukkit.getScheduler().runTask(this, () -> {
            Pending p = pending.remove(player.getUniqueId());
            if (p != null) {
                p.pollTask().cancel();
                p.timeoutTask().cancel();
            }
            if (!player.isOnline()) return;
            switch (status) {
                case "ok" -> {
                    player.setInvulnerable(false);
                    String address = player.getAddress() != null
                        ? player.getAddress().getAddress().getHostAddress() : "";
                    remembered.put(player.getName().toLowerCase(),
                        new Remembered(address, System.currentTimeMillis() + rememberMillis));
                    player.sendMessage(Component.text("K-ID verified — have fun!", NamedTextColor.GREEN));
                }
                case "denied" -> player.kick(Component.text(
                    "This nickname is tied to a different K-ID account."));
                default -> player.kick(Component.text(
                    "The K-ID link expired. Rejoin to get a new one."));
            }
        });
    }

    /* ---------- the freeze itself ---------- */

    private boolean frozen(Player player) {
        return pending.containsKey(player.getUniqueId());
    }

    @EventHandler
    public void onMove(PlayerMoveEvent e) {
        if (frozen(e.getPlayer()) && e.hasChangedBlock()) e.setCancelled(true);
    }

    @EventHandler
    public void onChat(AsyncChatEvent e) {
        if (frozen(e.getPlayer())) e.setCancelled(true);
    }

    @EventHandler
    public void onCommand(PlayerCommandPreprocessEvent e) {
        if (frozen(e.getPlayer())) e.setCancelled(true);
    }

    @EventHandler
    public void onInteract(PlayerInteractEvent e) {
        if (frozen(e.getPlayer())) e.setCancelled(true);
    }

    @EventHandler
    public void onBreak(BlockBreakEvent e) {
        if (frozen(e.getPlayer())) e.setCancelled(true);
    }

    @EventHandler
    public void onPlace(BlockPlaceEvent e) {
        if (frozen(e.getPlayer())) e.setCancelled(true);
    }

    @EventHandler
    public void onDrop(PlayerDropItemEvent e) {
        if (frozen(e.getPlayer())) e.setCancelled(true);
    }

    @EventHandler
    public void onPickup(EntityPickupItemEvent e) {
        if (e.getEntity() instanceof Player p && frozen(p)) e.setCancelled(true);
    }

    @EventHandler
    public void onDamage(EntityDamageEvent e) {
        if (e.getEntity() instanceof Player p && frozen(p)) e.setCancelled(true);
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent e) {
        Pending p = pending.remove(e.getPlayer().getUniqueId());
        if (p != null) {
            p.pollTask().cancel();
            p.timeoutTask().cancel();
        }
    }

    /* ---------- tiny HTTP helper ---------- */

    private JsonObject api(String method, String path, String body, String ignored) {
        try {
            HttpRequest.Builder rb = HttpRequest.newBuilder()
                .uri(URI.create(apiUrl + path))
                .timeout(Duration.ofSeconds(10))
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json");
            HttpRequest req = method.equals("POST")
                ? rb.POST(HttpRequest.BodyPublishers.ofString(body)).build()
                : rb.GET().build();
            HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
            return gson.fromJson(res.body(), JsonObject.class);
        } catch (IOException | InterruptedException e) {
            getLogger().warning("K-ID API call failed: " + e.getMessage());
            return null;
        }
    }
}
