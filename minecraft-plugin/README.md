# KidAuth — K-ID sign-in for Minecraft (Paper 1.21+)

Players joining an offline-mode server are frozen and get a one-time
`id.kiliw.com/mc#...` link in chat. Approving it in the browser
unfreezes them; a denial or timeout kicks them. The first approval
ties the nickname to the K-ID account, so nobody else can join under
that nick. With FastLogin installed, licensed (Mojang-authenticated)
players skip the whole thing.

## Build

Requires JDK 21 and Gradle (or the wrapper of any modern project):

    cd minecraft-plugin
    gradle build

The jar lands in `build/libs/KidAuth-1.0.0.jar`.

## Install

1. Put the jar into the server's `plugins/` folder, start once, stop.
2. In the Cloudflare dashboard (Workers -> your worker -> Settings ->
   Variables and Secrets) add a secret `MC_API_KEY` with a long random
   value — this is what lets *your* server issue sign-in links.
3. Put the same value into `plugins/KidAuth/config.yml` -> `api-key`,
   set `server-name`, restart.
4. `server.properties`: `online-mode=false`.
5. Optional: install FastLogin so licensed players skip K-ID.

## Notes

- Nick binding lives on the Kiliw side (`_auth/mcnick/...`); to move a
  nick to another account, remove that object (admin tooling can be
  added later).
- The auth timeout, remember window and server name are in config.yml.
