package com.kiliw.kid;

import org.bukkit.Bukkit;
import org.bukkit.event.Event;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;

import java.util.UUID;

/**
 * Optional FastLogin integration, wired entirely through reflection:
 * nothing from FastLogin is needed at compile time. When FastLogin
 * auto-logs a premium (Mojang-authenticated) player we mark them so
 * the K-ID step is skipped. Without FastLogin everyone simply goes
 * through K-ID.
 */
final class FastLoginHook {

    private static final String EVENT_CLASS =
        "com.github.games647.fastlogin.bukkit.event.BukkitFastLoginAutoLoginEvent";

    private FastLoginHook() { }

    @SuppressWarnings("unchecked")
    static void tryRegister(KidAuthPlugin plugin) {
        if (Bukkit.getPluginManager().getPlugin("FastLogin") == null) {
            plugin.getLogger().info("FastLogin not found — every player signs in through K-ID.");
            return;
        }
        try {
            Class<? extends Event> eventClass =
                (Class<? extends Event>) Class.forName(EVENT_CLASS);
            Bukkit.getPluginManager().registerEvent(
                eventClass,
                new Listener() { },
                EventPriority.MONITOR,
                (listener, event) -> {
                    try {
                        Object profile = event.getClass().getMethod("getProfile").invoke(event);
                        if (profile == null) return;
                        Object id = profile.getClass().getMethod("getId").invoke(profile);
                        if (id instanceof UUID uuid) plugin.markPremium(uuid);
                    } catch (ReflectiveOperationException ignored) {
                        /* incompatible FastLogin build: just skip the mark */
                    }
                },
                plugin,
                true
            );
            plugin.getLogger().info("FastLogin detected — licensed players skip K-ID.");
        } catch (ClassNotFoundException | ClassCastException e) {
            plugin.getLogger().warning("FastLogin found, but its API is incompatible — licensed players will go through K-ID too.");
        }
    }
}
