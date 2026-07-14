# KidAuth — K-ID sign-in for Minecraft (Paper 1.21+)

Players joining an offline-mode server are frozen and get two ways to
sign in with their K-ID:

- a one-time `t.me/<bot>?start=mc_...` link in chat that opens the
  Kiliw Telegram bot, and
- a **QR code drawn on a map in their hand** — scanning it with a
  phone opens the same bot.

Approving in the bot unfreezes them; a denial or timeout kicks them.
The first approval ties the nickname to the K-ID account, so nobody
else can join under that nick. Every player signs in this way — there
is no premium bypass.

The Telegram side needs `TG_BOT_TOKEN` + `TG_BOT_USERNAME` secrets on
the worker; without them the chat link and the QR fall back to the web
approval page (`/mc#...`).

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

## Essentials core

Alongside sign-in, the plugin ships a set of everyday commands:

- **Homes:** `/sethome [name]`, `/home [name]`, `/delhome <name>`, `/homes`
- **Spawn / warps:** `/spawn`, `/setspawn`, `/warp [name]`, `/setwarp <name>`,
  `/delwarp <name>`, `/warps`
- **Teleport:** `/tpa`, `/tpahere`, `/tpaccept`, `/tpdeny`, `/back`
- **State (op):** `/heal`, `/feed`, `/fly`, `/god`, `/gamemode` (`/gm`),
  `/speed`, `/repair`
- **Kits:** `/kit [name]`, `/kits` — defined under `kits:` in config.yml
- **Chat:** `/msg` (`/w`, `/tell`), `/reply` (`/r`), `/broadcast` (`/bc`, op),
  `/list`, `/afk`, `/nick` (op)
- **Teleport (op):** `/tp`, `/tphere`, `/tpall`; plus `/top`, `/near`
- **World (op):** `/time` (`/day`, `/night`), `/weather` (`/sun`)
- **Utility:** `/workbench` (`/wb`), `/enderchest` (`/ec`), `/hat`, `/ping`,
  `/more` (op), `/ext` (op), `/gmc` `/gms` `/gma` `/gmsp` (op)
- **Moderation (op):** `/kick`, `/ban`, `/unban`, `/clearinventory` (`/ci`),
  `/kill`, `/suicide`

Homes, warps and spawn are saved to `homes.yml` / `warps.yml` in the
plugin folder; bans use the vanilla ban list. Permissions are the
`kidauth.<command>` nodes (see plugin.yml); basic player commands default
to everyone, powerful ones to operators. `max-homes` in config.yml caps
homes per player (ops are unlimited).

## Notes

- Nick binding lives on the Kiliw side (`_auth/mcnick/...`); to move a
  nick to another account, remove that object (admin tooling can be
  added later).
- The auth timeout, remember window and server name are in config.yml.
