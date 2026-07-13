package com.kiliw.kid;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextDecoration;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.EntityPickupItemEvent;
import org.bukkit.event.inventory.InventoryClickEvent;
import io.papermc.paper.event.player.AsyncChatEvent;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.event.player.PlayerDropItemEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerItemHeldEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerSwapHandItemsEvent;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.MapMeta;
import org.bukkit.map.MapCanvas;
import org.bukkit.map.MapRenderer;
import org.bukkit.map.MapView;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;

import java.awt.Color;

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

    private record Pending(String token, String poll, BukkitTask pollTask, BukkitTask timeoutTask,
                           boolean gaveMap, ItemStack offhandPrev) { }

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

        String joinIp = player.getAddress() != null
            ? player.getAddress().getAddress().getHostAddress() : "";
        Bukkit.getScheduler().runTaskAsynchronously(this, () -> {
            JsonObject res = api("POST", "/api/mc", gson.toJson(Map.of(
                "action", "create",
                "nick", player.getName(),
                "server", serverName,
                "ip", joinIp
            )), null);
            if (res == null || !res.has("token")) {
                Bukkit.getScheduler().runTask(this, () ->
                    player.kick(Component.text("K-ID auth is unavailable right now. Try again in a minute.")));
                return;
            }
            String token = res.get("token").getAsString();
            String poll = res.get("poll").getAsString();
            String url = res.get("url").getAsString();
            boolean notified = res.has("notified") && res.get("notified").getAsBoolean();
            boolean[][] modules = parseQr(res);

            Bukkit.getScheduler().runTask(this, () -> {
                if (!player.isOnline()) return;

                /* the QR map goes into the offhand (shield slot); the
                   previous item comes back once the sign-in finishes */
                boolean gaveMap = false;
                ItemStack offhandPrev = null;
                if (modules != null) {
                    offhandPrev = player.getInventory().getItemInOffHand();
                    player.getInventory().setItemInOffHand(qrMap(player, modules));
                    gaveMap = true;
                }

                player.sendMessage(Component.empty());
                if (notified) {
                    player.sendMessage(Component.text("Confirmation sent to your Telegram — tap ✅ there.", NamedTextColor.GREEN)
                        .decoration(TextDecoration.BOLD, true));
                } else {
                    player.sendMessage(Component.text("Sign in to play:", NamedTextColor.WHITE)
                        .decoration(TextDecoration.BOLD, true));
                }
                player.sendMessage(Component.text(url, NamedTextColor.GOLD)
                    .decoration(TextDecoration.UNDERLINED, true)
                    .clickEvent(ClickEvent.openUrl(url)));
                if (gaveMap) {
                    player.sendMessage(Component.text(
                        "…or scan the map in your left hand with your phone — it opens the Telegram bot.",
                        NamedTextColor.GRAY));
                }
                player.sendMessage(Component.text("The link works once and expires in 5 minutes.", NamedTextColor.GRAY));
                player.sendMessage(Component.empty());

                BukkitTask pollTask = Bukkit.getScheduler().runTaskTimerAsynchronously(this,
                    () -> pollOnce(player, token, poll), 40L, 40L);
                BukkitTask timeoutTask = Bukkit.getScheduler().runTaskLater(this, () -> {
                    Pending p = pending.remove(player.getUniqueId());
                    if (p != null) {
                        p.pollTask().cancel();
                        restoreOffhand(player, p);
                        player.setInvulnerable(false);
                        player.kick(Component.text("Sign-in timed out. Rejoin to try again."));
                    }
                }, timeoutSeconds * 20L);
                pending.put(player.getUniqueId(),
                    new Pending(token, poll, pollTask, timeoutTask, gaveMap, offhandPrev));
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
            if (p != null) restoreOffhand(player, p);
            player.setInvulnerable(false);
            switch (status) {
                case "ok" -> {
                    String address = player.getAddress() != null
                        ? player.getAddress().getAddress().getHostAddress() : "";
                    remembered.put(player.getName().toLowerCase(),
                        new Remembered(address, System.currentTimeMillis() + rememberMillis));
                    player.sendMessage(Component.text("Verified — have fun!", NamedTextColor.GREEN));
                }
                case "denied" -> player.kick(Component.text(
                    "This nickname is tied to a different account."));
                default -> player.kick(Component.text(
                    "The sign-in link expired. Rejoin to get a new one."));
            }
        });
    }

    /* ---------- the QR map ---------- */

    private boolean[][] parseQr(JsonObject res) {
        try {
            if (!res.has("qr") || res.get("qr").isJsonNull()) return null;
            JsonArray rows = res.getAsJsonArray("qr");
            boolean[][] modules = new boolean[rows.size()][];
            for (int r = 0; r < rows.size(); r++) {
                String row = rows.get(r).getAsString();
                modules[r] = new boolean[row.length()];
                for (int c = 0; c < row.length(); c++) modules[r][c] = row.charAt(c) == '1';
            }
            return modules.length >= 21 ? modules : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    /* site-styled QR: light modules on a dark background with rounded
       finder eyes (dense squares for the data keep it scannable) */

    private static final Color QR_BG = new Color(12, 12, 12);
    private static final Color QR_FG = new Color(242, 242, 242);

    private static boolean inEye(int n, int r, int c) {
        return (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
    }

    /* rounded-rectangle membership test, mirrored 1:1 by the decode test */
    private static boolean inRound(int px, int py, int w, int h, int r) {
        int cx = Math.max(r - px, px - (w - 1 - r));
        int cy = Math.max(r - py, py - (h - 1 - r));
        if (cx <= 0 || cy <= 0) return true;
        return cx * cx + cy * cy <= r * r;
    }

    private static void fillRound(MapCanvas c, int x, int y, int w, int h, int r, Color col) {
        for (int py = 0; py < h; py++) {
            for (int px = 0; px < w; px++) {
                if (inRound(px, py, w, h, r)) c.setPixelColor(x + px, y + py, col);
            }
        }
    }

    private static void drawEye(MapCanvas c, int x, int y, int scale) {
        int s = 7 * scale;
        fillRound(c, x, y, s, s, scale + 1, QR_FG);
        fillRound(c, x + scale, y + scale, s - 2 * scale, s - 2 * scale, scale, QR_BG);
        fillRound(c, x + 2 * scale, y + 2 * scale, s - 4 * scale, s - 4 * scale, scale, QR_FG);
    }

    private ItemStack qrMap(Player player, boolean[][] modules) {
        MapView view = Bukkit.createMap(player.getWorld());
        view.getRenderers().forEach(view::removeRenderer);
        view.setScale(MapView.Scale.CLOSEST);
        view.setLocked(true);
        view.addRenderer(new MapRenderer() {
            private boolean drawn;

            @Override
            public void render(MapView v, MapCanvas canvas, Player p) {
                if (drawn) return;
                drawn = true;
                int n = modules.length;
                int scale = Math.max(1, 128 / (n + 2));
                int off = (128 - n * scale) / 2;
                for (int x = 0; x < 128; x++) {
                    for (int y = 0; y < 128; y++) canvas.setPixelColor(x, y, QR_BG);
                }
                for (int r = 0; r < n; r++) {
                    for (int c = 0; c < n; c++) {
                        if (!modules[r][c] || inEye(n, r, c)) continue;
                        for (int dy = 0; dy < scale; dy++) {
                            for (int dx = 0; dx < scale; dx++) {
                                canvas.setPixelColor(off + c * scale + dx, off + r * scale + dy, QR_FG);
                            }
                        }
                    }
                }
                drawEye(canvas, off, off, scale);
                drawEye(canvas, off + (n - 7) * scale, off, scale);
                drawEye(canvas, off, off + (n - 7) * scale, scale);
            }
        });
        ItemStack item = new ItemStack(Material.FILLED_MAP);
        MapMeta meta = (MapMeta) item.getItemMeta();
        meta.setMapView(view);
        meta.displayName(Component.text("Sign-in code", NamedTextColor.GOLD));
        item.setItemMeta(meta);
        return item;
    }

    private void restoreOffhand(Player player, Pending p) {
        if (p.gaveMap() && player.isOnline()) {
            player.getInventory().setItemInOffHand(p.offhandPrev());
        }
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
    public void onInvClick(InventoryClickEvent e) {
        if (e.getWhoClicked() instanceof Player p && frozen(p)) e.setCancelled(true);
    }

    @EventHandler
    public void onHeldChange(PlayerItemHeldEvent e) {
        if (frozen(e.getPlayer())) e.setCancelled(true);
    }

    @EventHandler
    public void onSwapHands(PlayerSwapHandItemsEvent e) {
        if (frozen(e.getPlayer())) e.setCancelled(true);
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent e) {
        Pending p = pending.remove(e.getPlayer().getUniqueId());
        if (p != null) {
            p.pollTask().cancel();
            p.timeoutTask().cancel();
            restoreOffhand(e.getPlayer(), p);
            e.getPlayer().setInvulnerable(false);
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
