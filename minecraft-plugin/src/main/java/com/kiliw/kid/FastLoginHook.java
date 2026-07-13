package com.kiliw.kid;

import org.bukkit.Bukkit;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;

/**
 * Optional FastLogin integration: when FastLogin auto-logs a premium
 * (Mojang-authenticated) player, we mark them so the K-ID step is
 * skipped. Loaded reflectively — the plugin works without FastLogin,
 * everyone just goes through K-ID.
 */
final class FastLoginHook {

    private FastLoginHook() { }

    static void tryRegister(KidAuthPlugin plugin) {
        if (Bukkit.getPluginManager().getPlugin("FastLogin") == null) {
            plugin.getLogger().info("FastLogin not found — every player signs in through K-ID.");
            return;
        }
        try {
            Class.forName("com.github.games647.fastlogin.bukkit.event.BukkitFastLoginAutoLoginEvent");
            Bukkit.getPluginManager().registerEvents(new AutoLoginListener(plugin), plugin);
            plugin.getLogger().info("FastLogin detected — licensed players skip K-ID.");
        } catch (ClassNotFoundException e) {
            plugin.getLogger().warning("FastLogin found, but its API is incompatible: " + e.getMessage());
        }
    }

    /** separate class so the event type only loads when FastLogin exists */
    static final class AutoLoginListener implements Listener {
        private final KidAuthPlugin plugin;

        AutoLoginListener(KidAuthPlugin plugin) {
            this.plugin = plugin;
        }

        @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
        public void onAutoLogin(com.github.games647.fastlogin.bukkit.event.BukkitFastLoginAutoLoginEvent event) {
            var profile = event.getProfile();
            if (profile != null && profile.getId() != null) {
                plugin.markPremium(profile.getId());
            }
        }
    }
}
