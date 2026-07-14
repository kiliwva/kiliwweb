package com.kiliw.kid;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.BanList;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerTeleportEvent;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.Damageable;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.File;
import java.io.IOException;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Essentials-style core commands baked into the plugin: homes, spawn,
 * warps, teleport requests, /back, player state (heal/feed/fly/god/
 * gamemode/speed), kits, private messages and basic moderation.
 *
 * Homes / warps / spawn persist to YAML in the plugin's data folder;
 * bans use the vanilla ban list. All commands are declared in
 * plugin.yml, so Bukkit handles the permission gate before onCommand.
 */
public final class EssentialsModule implements CommandExecutor, Listener {

    private final JavaPlugin plugin;

    private final File homesFile;
    private final File warpsFile;
    private YamlConfiguration homes;   // homes.<uuid>.<name> = Location
    private YamlConfiguration world;   // warps.<name> = Location ; spawn = Location

    /** last location before a teleport / death, for /back */
    private final Map<UUID, Location> lastLoc = new ConcurrentHashMap<>();
    /** pending teleport requests, keyed by the player who must answer */
    private final Map<UUID, TpRequest> tpRequests = new ConcurrentHashMap<>();
    /** last person to /msg you, for /reply */
    private final Map<UUID, UUID> replyTo = new ConcurrentHashMap<>();
    /** kit cooldowns: "<uuid>:<kit>" -> epoch millis when last claimed */
    private final Map<String, Long> kitUsed = new ConcurrentHashMap<>();

    private static final long TPA_TIMEOUT = 60_000L;

    private record TpRequest(UUID from, boolean here, long expires) { }

    EssentialsModule(JavaPlugin plugin) {
        this.plugin = plugin;
        this.homesFile = new File(plugin.getDataFolder(), "homes.yml");
        this.warpsFile = new File(plugin.getDataFolder(), "warps.yml");
    }

    /* ---------- lifecycle ---------- */

    private static final String[] COMMANDS = {
        "sethome", "home", "delhome", "homes",
        "spawn", "setspawn", "warp", "setwarp", "delwarp", "warps",
        "tpa", "tpahere", "tpaccept", "tpdeny", "back",
        "heal", "feed", "fly", "god", "gamemode", "speed",
        "kit", "kits", "msg", "reply",
        "workbench", "enderchest", "repair", "hat",
        "kick", "ban", "unban", "clearinventory",
    };

    void register() {
        plugin.getDataFolder().mkdirs();
        homes = YamlConfiguration.loadConfiguration(homesFile);
        world = YamlConfiguration.loadConfiguration(warpsFile);
        for (String name : COMMANDS) {
            if (plugin.getCommand(name) != null) plugin.getCommand(name).setExecutor(this);
        }
        Bukkit.getPluginManager().registerEvents(this, plugin);
    }

    void save() {
        try { homes.save(homesFile); } catch (IOException ignored) { /* best effort */ }
        try { world.save(warpsFile); } catch (IOException ignored) { /* best effort */ }
    }

    private void saveHomes() { try { homes.save(homesFile); } catch (IOException ignored) { } }

    private void saveWorld() { try { world.save(warpsFile); } catch (IOException ignored) { } }

    /* ---------- small helpers ---------- */

    private static void tell(CommandSender s, String text, NamedTextColor color) {
        s.sendMessage(Component.text(text, color));
    }

    private static void ok(CommandSender s, String t) { tell(s, t, NamedTextColor.GREEN); }

    private static void err(CommandSender s, String t) { tell(s, t, NamedTextColor.RED); }

    private static void info(CommandSender s, String t) { tell(s, t, NamedTextColor.GRAY); }

    private static Player asPlayer(CommandSender s) {
        return s instanceof Player p ? p : null;
    }

    private void remember(Player p) { lastLoc.put(p.getUniqueId(), p.getLocation()); }

    private boolean canTargetOthers(CommandSender s) {
        return s.isOp() || s.hasPermission("kidauth.admin");
    }

    /* ---------- events (for /back) ---------- */

    @EventHandler
    public void onTeleport(PlayerTeleportEvent e) {
        if (e.getFrom() != null && (e.getTo() == null || !e.getFrom().equals(e.getTo()))) {
            lastLoc.put(e.getPlayer().getUniqueId(), e.getFrom());
        }
    }

    @EventHandler
    public void onDeath(PlayerDeathEvent e) {
        lastLoc.put(e.getEntity().getUniqueId(), e.getEntity().getLocation());
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent e) {
        tpRequests.remove(e.getPlayer().getUniqueId());
    }

    /* ---------- command dispatch ---------- */

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        String cmd = command.getName().toLowerCase(Locale.ROOT);
        try {
            switch (cmd) {
                case "sethome" -> setHome(sender, args);
                case "home" -> home(sender, args);
                case "delhome" -> delHome(sender, args);
                case "homes" -> listHomes(sender);
                case "spawn" -> spawn(sender);
                case "setspawn" -> setSpawn(sender);
                case "warp" -> warp(sender, args);
                case "setwarp" -> setWarp(sender, args);
                case "delwarp" -> delWarp(sender, args);
                case "warps" -> listWarps(sender);
                case "tpa" -> tpa(sender, args, false);
                case "tpahere" -> tpa(sender, args, true);
                case "tpaccept" -> tpAnswer(sender, true);
                case "tpdeny" -> tpAnswer(sender, false);
                case "back" -> back(sender);
                case "heal" -> heal(sender, args);
                case "feed" -> feed(sender, args);
                case "fly" -> fly(sender, args);
                case "god" -> god(sender, args);
                case "gamemode" -> gamemode(sender, args);
                case "speed" -> speed(sender, args);
                case "kit" -> kit(sender, args);
                case "kits" -> listKits(sender);
                case "msg" -> msg(sender, args);
                case "reply" -> reply(sender, args);
                case "workbench" -> workbench(sender);
                case "enderchest" -> enderchest(sender);
                case "repair" -> repair(sender);
                case "hat" -> hat(sender);
                case "kick" -> kick(sender, args);
                case "ban" -> ban(sender, args);
                case "unban" -> unban(sender, args);
                case "clearinventory" -> clearInventory(sender, args);
                default -> { return false; }
            }
        } catch (RuntimeException ex) {
            err(sender, "Command failed: " + ex.getMessage());
        }
        return true;
    }

    /* ---------- homes ---------- */

    private String homePath(Player p, String name) {
        return "homes." + p.getUniqueId() + "." + name.toLowerCase(Locale.ROOT);
    }

    private void setHome(CommandSender s, String[] a) {
        Player p = asPlayer(s);
        if (p == null) { err(s, "Players only."); return; }
        String name = a.length > 0 ? a[0] : "home";
        ConfigurationSection sec = homes.getConfigurationSection("homes." + p.getUniqueId());
        int count = sec == null ? 0 : sec.getKeys(false).size();
        int max = plugin.getConfig().getInt("max-homes", 5);
        boolean exists = homes.contains(homePath(p, name));
        if (!exists && !p.isOp() && max > 0 && count >= max) {
            err(s, "Home limit reached (" + max + "). Delete one with /delhome.");
            return;
        }
        homes.set(homePath(p, name), p.getLocation());
        saveHomes();
        ok(s, "Home \"" + name + "\" set.");
    }

    private void home(CommandSender s, String[] a) {
        Player p = asPlayer(s);
        if (p == null) { err(s, "Players only."); return; }
        ConfigurationSection sec = homes.getConfigurationSection("homes." + p.getUniqueId());
        if (sec == null || sec.getKeys(false).isEmpty()) { err(s, "You have no homes. Use /sethome."); return; }
        String name;
        if (a.length > 0) {
            name = a[0].toLowerCase(Locale.ROOT);
        } else if (sec.getKeys(false).size() == 1) {
            name = sec.getKeys(false).iterator().next();
        } else {
            info(s, "Your homes: " + String.join(", ", sec.getKeys(false)));
            return;
        }
        Location loc = homes.getLocation(homePath(p, name));
        if (loc == null || loc.getWorld() == null) { err(s, "No home named \"" + name + "\"."); return; }
        remember(p);
        p.teleport(loc);
        ok(s, "Teleported to \"" + name + "\".");
    }

    private void delHome(CommandSender s, String[] a) {
        Player p = asPlayer(s);
        if (p == null) { err(s, "Players only."); return; }
        if (a.length == 0) { err(s, "Usage: /delhome <name>"); return; }
        String name = a[0].toLowerCase(Locale.ROOT);
        if (!homes.contains(homePath(p, name))) { err(s, "No home named \"" + name + "\"."); return; }
        homes.set(homePath(p, name), null);
        saveHomes();
        ok(s, "Home \"" + name + "\" deleted.");
    }

    private void listHomes(CommandSender s) {
        Player p = asPlayer(s);
        if (p == null) { err(s, "Players only."); return; }
        ConfigurationSection sec = homes.getConfigurationSection("homes." + p.getUniqueId());
        if (sec == null || sec.getKeys(false).isEmpty()) { info(s, "You have no homes."); return; }
        info(s, "Homes: " + String.join(", ", sec.getKeys(false)));
    }

    /* ---------- spawn ---------- */

    private void spawn(CommandSender s) {
        Player p = asPlayer(s);
        if (p == null) { err(s, "Players only."); return; }
        Location loc = world.getLocation("spawn");
        if (loc == null || loc.getWorld() == null) {
            loc = p.getWorld().getSpawnLocation();
        }
        remember(p);
        p.teleport(loc);
        ok(s, "Teleported to spawn.");
    }

    private void setSpawn(CommandSender s) {
        Player p = asPlayer(s);
        if (p == null) { err(s, "Players only."); return; }
        world.set("spawn", p.getLocation());
        saveWorld();
        p.getWorld().setSpawnLocation(p.getLocation());
        ok(s, "Server spawn set.");
    }

    /* ---------- warps ---------- */

    private void warp(CommandSender s, String[] a) {
        Player p = asPlayer(s);
        if (p == null) { err(s, "Players only."); return; }
        if (a.length == 0) { listWarps(s); return; }
        Location loc = world.getLocation("warps." + a[0].toLowerCase(Locale.ROOT));
        if (loc == null || loc.getWorld() == null) { err(s, "No warp named \"" + a[0] + "\"."); return; }
        remember(p);
        p.teleport(loc);
        ok(s, "Warped to \"" + a[0] + "\".");
    }

    private void setWarp(CommandSender s, String[] a) {
        Player p = asPlayer(s);
        if (p == null) { err(s, "Players only."); return; }
        if (a.length == 0) { err(s, "Usage: /setwarp <name>"); return; }
        world.set("warps." + a[0].toLowerCase(Locale.ROOT), p.getLocation());
        saveWorld();
        ok(s, "Warp \"" + a[0] + "\" set.");
    }

    private void delWarp(CommandSender s, String[] a) {
        if (a.length == 0) { err(s, "Usage: /delwarp <name>"); return; }
        String key = "warps." + a[0].toLowerCase(Locale.ROOT);
        if (!world.contains(key)) { err(s, "No warp named \"" + a[0] + "\"."); return; }
        world.set(key, null);
        saveWorld();
        ok(s, "Warp \"" + a[0] + "\" deleted.");
    }

    private void listWarps(CommandSender s) {
        ConfigurationSection sec = world.getConfigurationSection("warps");
        if (sec == null || sec.getKeys(false).isEmpty()) { info(s, "No warps set."); return; }
        info(s, "Warps: " + String.join(", ", sec.getKeys(false)));
    }

    /* ---------- teleport requests ---------- */

    private void tpa(CommandSender s, String[] a, boolean here) {
        Player p = asPlayer(s);
        if (p == null) { err(s, "Players only."); return; }
        if (a.length == 0) { err(s, "Usage: /" + (here ? "tpahere" : "tpa") + " <player>"); return; }
        Player target = Bukkit.getPlayerExact(a[0]);
        if (target == null || target.equals(p)) { err(s, "Player not found."); return; }
        tpRequests.put(target.getUniqueId(), new TpRequest(p.getUniqueId(), here, System.currentTimeMillis() + TPA_TIMEOUT));
        ok(s, "Request sent to " + target.getName() + ".");
        tell(target, p.getName() + (here ? " wants you to teleport to them." : " wants to teleport to you."), NamedTextColor.AQUA);
        info(target, "/tpaccept to allow, /tpdeny to refuse (60s).");
    }

    private void tpAnswer(CommandSender s, boolean accept) {
        Player me = asPlayer(s);
        if (me == null) { err(s, "Players only."); return; }
        TpRequest req = tpRequests.remove(me.getUniqueId());
        if (req == null || req.expires() < System.currentTimeMillis()) { err(s, "No pending request."); return; }
        Player other = Bukkit.getPlayer(req.from());
        if (other == null) { err(s, "That player is no longer online."); return; }
        if (!accept) { info(s, "Request denied."); info(other, me.getName() + " denied your request."); return; }
        if (req.here()) {
            remember(me);
            me.teleport(other.getLocation());
        } else {
            remember(other);
            other.teleport(me.getLocation());
        }
        ok(s, "Teleport accepted.");
        ok(other, me.getName() + " accepted your request.");
    }

    private void back(CommandSender s) {
        Player p = asPlayer(s);
        if (p == null) { err(s, "Players only."); return; }
        Location loc = lastLoc.get(p.getUniqueId());
        if (loc == null || loc.getWorld() == null) { err(s, "Nowhere to go back to."); return; }
        Location cur = p.getLocation();
        p.teleport(loc);
        lastLoc.put(p.getUniqueId(), cur);
        ok(s, "Returned to your previous location.");
    }

    /* ---------- player state ---------- */

    private Player resolveTarget(CommandSender s, String[] a, int idx) {
        if (a.length > idx) {
            if (!canTargetOthers(s)) { err(s, "You can only affect yourself."); return null; }
            Player t = Bukkit.getPlayerExact(a[idx]);
            if (t == null) { err(s, "Player not found."); return null; }
            return t;
        }
        Player self = asPlayer(s);
        if (self == null) err(s, "Console must name a player.");
        return self;
    }

    private void heal(CommandSender s, String[] a) {
        Player t = resolveTarget(s, a, 0);
        if (t == null) return;
        double max = 20.0;
        try { max = t.getMaxHealth(); } catch (Throwable ignored) { /* stays 20 */ }
        t.setHealth(max);
        t.setFoodLevel(20);
        t.setSaturation(20f);
        t.setFireTicks(0);
        ok(s, "Healed " + t.getName() + ".");
        if (!t.equals(s)) ok(t, "You have been healed.");
    }

    private void feed(CommandSender s, String[] a) {
        Player t = resolveTarget(s, a, 0);
        if (t == null) return;
        t.setFoodLevel(20);
        t.setSaturation(20f);
        ok(s, "Fed " + t.getName() + ".");
        if (!t.equals(s)) ok(t, "You have been fed.");
    }

    private void fly(CommandSender s, String[] a) {
        Player t = resolveTarget(s, a, 0);
        if (t == null) return;
        boolean on = !t.getAllowFlight();
        t.setAllowFlight(on);
        if (!on) t.setFlying(false);
        ok(s, "Flight " + (on ? "enabled" : "disabled") + " for " + t.getName() + ".");
        if (!t.equals(s)) ok(t, "Flight " + (on ? "enabled" : "disabled") + ".");
    }

    private void god(CommandSender s, String[] a) {
        Player t = resolveTarget(s, a, 0);
        if (t == null) return;
        boolean on = !t.isInvulnerable();
        t.setInvulnerable(on);
        ok(s, "God mode " + (on ? "enabled" : "disabled") + " for " + t.getName() + ".");
        if (!t.equals(s)) ok(t, "God mode " + (on ? "enabled" : "disabled") + ".");
    }

    private void gamemode(CommandSender s, String[] a) {
        if (a.length == 0) { err(s, "Usage: /gamemode <mode> [player]"); return; }
        GameMode mode = parseMode(a[0]);
        if (mode == null) { err(s, "Unknown mode. Use survival, creative, adventure or spectator."); return; }
        Player t = resolveTarget(s, a, 1);
        if (t == null) return;
        t.setGameMode(mode);
        ok(s, t.getName() + " is now in " + mode.name().toLowerCase(Locale.ROOT) + " mode.");
        if (!t.equals(s)) ok(t, "Your game mode is now " + mode.name().toLowerCase(Locale.ROOT) + ".");
    }

    private static GameMode parseMode(String v) {
        return switch (v.toLowerCase(Locale.ROOT)) {
            case "0", "s", "survival" -> GameMode.SURVIVAL;
            case "1", "c", "creative" -> GameMode.CREATIVE;
            case "2", "a", "adventure" -> GameMode.ADVENTURE;
            case "3", "sp", "spectator" -> GameMode.SPECTATOR;
            default -> null;
        };
    }

    private void speed(CommandSender s, String[] a) {
        if (a.length == 0) { err(s, "Usage: /speed <0-10> [player]"); return; }
        float n;
        try { n = Float.parseFloat(a[0]); } catch (NumberFormatException e) { err(s, "Speed must be a number 0-10."); return; }
        n = Math.max(0f, Math.min(10f, n));
        Player t = resolveTarget(s, a, 1);
        if (t == null) return;
        float v = n / 10f;
        if (t.isFlying() || t.getAllowFlight()) t.setFlySpeed(v);
        else t.setWalkSpeed(v);
        ok(s, "Speed set to " + n + " for " + t.getName() + ".");
    }

    /* ---------- kits ---------- */

    private void kit(CommandSender s, String[] a) {
        Player p = asPlayer(s);
        if (p == null) { err(s, "Players only."); return; }
        ConfigurationSection kits = plugin.getConfig().getConfigurationSection("kits");
        if (kits == null || kits.getKeys(false).isEmpty()) { err(s, "No kits are configured."); return; }
        if (a.length == 0) { info(s, "Kits: " + String.join(", ", kits.getKeys(false))); return; }
        String name = a[0].toLowerCase(Locale.ROOT);
        ConfigurationSection kit = kits.getConfigurationSection(name);
        if (kit == null) { err(s, "No kit named \"" + a[0] + "\"."); return; }
        if (!p.hasPermission("kidauth.kit." + name) && !p.isOp()
            && kit.getBoolean("permission-required", false)) {
            err(s, "You don't have access to that kit.");
            return;
        }
        long cooldown = kit.getLong("cooldown", 0L) * 1000L;
        String ck = p.getUniqueId() + ":" + name;
        long last = kitUsed.getOrDefault(ck, 0L);
        long now = System.currentTimeMillis();
        if (cooldown > 0 && !p.isOp() && now - last < cooldown) {
            long left = (cooldown - (now - last)) / 1000L;
            err(s, "Kit on cooldown — " + left + "s left.");
            return;
        }
        List<String> items = kit.getStringList("items");
        if (items.isEmpty()) { err(s, "That kit is empty."); return; }
        for (String line : items) {
            String[] parts = line.trim().split("\\s+");
            Material mat = Material.matchMaterial(parts[0]);
            if (mat == null) continue;
            int amount = 1;
            if (parts.length > 1) {
                try { amount = Math.max(1, Integer.parseInt(parts[1])); } catch (NumberFormatException ignored) { }
            }
            p.getInventory().addItem(new ItemStack(mat, amount)).values()
                .forEach(left -> p.getWorld().dropItem(p.getLocation(), left));
        }
        kitUsed.put(ck, now);
        ok(s, "Kit \"" + name + "\" claimed.");
    }

    private void listKits(CommandSender s) {
        ConfigurationSection kits = plugin.getConfig().getConfigurationSection("kits");
        if (kits == null || kits.getKeys(false).isEmpty()) { info(s, "No kits are configured."); return; }
        info(s, "Kits: " + String.join(", ", kits.getKeys(false)));
    }

    /* ---------- messaging ---------- */

    private void msg(CommandSender s, String[] a) {
        if (a.length < 2) { err(s, "Usage: /msg <player> <message>"); return; }
        Player target = Bukkit.getPlayerExact(a[0]);
        if (target == null) { err(s, "Player not found."); return; }
        String text = String.join(" ", java.util.Arrays.copyOfRange(a, 1, a.length));
        String from = s instanceof Player ? s.getName() : "Console";
        tell(target, "[" + from + " -> you] " + text, NamedTextColor.LIGHT_PURPLE);
        tell(s, "[you -> " + target.getName() + "] " + text, NamedTextColor.LIGHT_PURPLE);
        /* let the target /reply to a player sender */
        if (s instanceof Player sp) replyTo.put(target.getUniqueId(), sp.getUniqueId());
    }

    private void reply(CommandSender s, String[] a) {
        Player p = asPlayer(s);
        if (p == null) { err(s, "Players only."); return; }
        if (a.length == 0) { err(s, "Usage: /reply <message>"); return; }
        UUID toId = replyTo.get(p.getUniqueId());
        Player target = toId == null ? null : Bukkit.getPlayer(toId);
        if (target == null) { err(s, "Nobody to reply to."); return; }
        String text = String.join(" ", a);
        tell(target, "[" + p.getName() + " -> you] " + text, NamedTextColor.LIGHT_PURPLE);
        tell(p, "[you -> " + target.getName() + "] " + text, NamedTextColor.LIGHT_PURPLE);
        replyTo.put(target.getUniqueId(), p.getUniqueId());
    }

    /* ---------- utility ---------- */

    private void workbench(CommandSender s) {
        Player p = asPlayer(s);
        if (p == null) { err(s, "Players only."); return; }
        p.openWorkbench(null, true);
    }

    private void enderchest(CommandSender s) {
        Player p = asPlayer(s);
        if (p == null) { err(s, "Players only."); return; }
        p.openInventory(p.getEnderChest());
    }

    private void repair(CommandSender s) {
        Player p = asPlayer(s);
        if (p == null) { err(s, "Players only."); return; }
        ItemStack item = p.getInventory().getItemInMainHand();
        if (item == null || item.getType().isAir()) { err(s, "Hold an item to repair."); return; }
        ItemMeta meta = item.getItemMeta();
        if (!(meta instanceof Damageable dmg) || !dmg.hasDamage()) { err(s, "That item can't be repaired."); return; }
        dmg.setDamage(0);
        item.setItemMeta(meta);
        ok(s, "Item repaired.");
    }

    private void hat(CommandSender s) {
        Player p = asPlayer(s);
        if (p == null) { err(s, "Players only."); return; }
        ItemStack hand = p.getInventory().getItemInMainHand();
        if (hand == null || hand.getType().isAir()) { err(s, "Hold an item to wear."); return; }
        ItemStack head = p.getInventory().getHelmet();
        p.getInventory().setHelmet(hand.clone());
        p.getInventory().setItemInMainHand(head);
        ok(s, "Enjoy your new hat.");
    }

    private void clearInventory(CommandSender s, String[] a) {
        Player t = resolveTarget(s, a, 0);
        if (t == null) return;
        t.getInventory().clear();
        ok(s, "Cleared inventory of " + t.getName() + ".");
        if (!t.equals(s)) info(t, "Your inventory was cleared by an admin.");
    }

    /* ---------- moderation ---------- */

    private void kick(CommandSender s, String[] a) {
        if (a.length == 0) { err(s, "Usage: /kick <player> [reason]"); return; }
        Player t = Bukkit.getPlayerExact(a[0]);
        if (t == null) { err(s, "Player not found."); return; }
        String reason = a.length > 1 ? String.join(" ", java.util.Arrays.copyOfRange(a, 1, a.length)) : "Kicked by an operator";
        t.kick(Component.text(reason));
        ok(s, "Kicked " + a[0] + ".");
    }

    @SuppressWarnings({ "unchecked", "rawtypes" })
    private void ban(CommandSender s, String[] a) {
        if (a.length == 0) { err(s, "Usage: /ban <player> [reason]"); return; }
        String name = a[0];
        String reason = a.length > 1 ? String.join(" ", java.util.Arrays.copyOfRange(a, 1, a.length)) : "Banned by an operator";
        BanList banList = Bukkit.getBanList(BanList.Type.NAME);
        banList.addBan(name, reason, null, s.getName());
        Player t = Bukkit.getPlayerExact(name);
        if (t != null) t.kick(Component.text(reason));
        ok(s, "Banned " + name + ".");
    }

    @SuppressWarnings({ "unchecked", "rawtypes" })
    private void unban(CommandSender s, String[] a) {
        if (a.length == 0) { err(s, "Usage: /unban <player>"); return; }
        BanList banList = Bukkit.getBanList(BanList.Type.NAME);
        banList.pardon(a[0]);
        ok(s, "Unbanned " + a[0] + ".");
    }
}
