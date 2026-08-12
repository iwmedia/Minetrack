<p align="center">
	<img width="120" height="120" src="assets/images/logo.svg">
</p>

# Minetrack
Minetrack makes it easy to keep an eye on your favorite Minecraft servers. Simple and hackable, Minetrack easily runs on any hardware. Use it for monitoring, analytics, or just for fun. [Check it out](https://minetrack.me).

This is a fork of [Cryptkeeper/Minetrack](https://github.com/Cryptkeeper/Minetrack) that uses MongoDB instead of SQLite for database logging.

### This project is not actively supported!
This project is not actively supported. Pull requests will be reviewed and merged (if accepted), but issues _might_ not be addressed outside of fixes provided by community members. Please share any improvements or fixes you've made so everyone can benefit from them.

### Features
- 🚀 Real time Minecraft server player count tracking with customizable update speed.
- 📝 Historical player count logging with 24 hour peak and player count record tracking.
- 📈 Historical graph with customizable time frame.
- 📦 Out of the box included dashboard with various customizable sorting and viewing options.
- 📱(Decent) mobile support.
- 🕹 Supports both Minecraft Java Edition and Minecraft Bedrock Edition.

### Community Showcase
You can find a list of community hosted instances below. Want to be listed here? Add yourself in a pull request!

* https://minetrack.me
* https://bedrock.minetrack.me
* https://minetrack.gg
* https://suomimine.fi
* https://minetrack.geyserconnect.net
* https://minetrack.fi
* https://www.anarchytrack.live/
* https://track.axsoter.com
* https://pvp-factions.fr
* https://stats.liste-serveurs.fr
* https://minetrack.galaxite.dev
* https://livemc.org
* https://track.pacor.ro
* https://minetrack.spielelp.de
* https://tracking.v4guard.io

## Updates
For updates and release notes, please read the [CHANGELOG](docs/CHANGELOG.md).

**Migrating to Minetrack 5?** See the [migration guide](docs/MIGRATING.md).

## Installation
1. Node 22+ is required (you can check your version using `node -v`)
2. Make sure everything is correct in ```config.json``` — every value can also be overridden via environment variables (see table below).
3. Add/remove servers by inserting documents into the MongoDB ```servers``` collection: ```{ name, ip, type: "JAVA"|"BEDROCK" }``` (optional: ```port```, ```color```, ```pinnedProtocol``` — pins pings to one protocol id for servers whose proxy resets unknown protocols; disables supported-version detection for that server). Changes require a restart.
4. Run ```npm install```
5. Run ```npm run build``` (this bundles `assets/` into `dist/`)
6. Run ```node main.js``` to boot the system (may need sudo!)

(There's also ```install.sh``` and ```start.sh```, but they may not work for your OS.)

Minecraft protocol versions are fetched at startup from [PrismarineJS/minecraft-data](https://github.com/PrismarineJS/minecraft-data) and refreshed every 24 hours, so new Minecraft releases are picked up without a redeploy. Startup requires GitHub to be reachable.

Database logging is disabled by default. You can enable it in ```config.json``` by setting ```logToDatabase``` to true.
This requires a MongoDB instance. Set the connection string via the ```MONGO_URI``` environment variable, e.g. ```MONGO_URI=mongodb://localhost:27017/minetrack```. If the URI does not include a database name, ```minetrack``` is used.

### Environment variables
`MONGO_URI` is required; everything else is optional and falls back to the value in `config.json`.

| Variable | Default | Description |
|---|---|---|
| `MONGO_URI` | — (required) | MongoDB connection string; the database name is taken from the URI path (`minetrack` if omitted) |
| `SITE_PORT` | `8080` | HTTP/WebSocket port |
| `SITE_IP` | `0.0.0.0` | Bind address |
| `RATES_PING_ALL` | `3000` | Interval between ping rounds in ms |
| `RATES_CONNECT_TIMEOUT` | `2500` | Ping connect timeout in ms |
| `LOG_TO_DATABASE` | `true` | Log pings to MongoDB and enable the history graph |
| `LOG_FAILED_PINGS` | `true` | Log failed pings |
| `GRAPH_DURATION` | `86400000` | Time window of the history graph in ms |
| `SERVER_GRAPH_DURATION` | `180000` | Time window of the per-server graphs in ms |
| `RETENTION_ENABLED` | `true` | Run hourly/daily rollups and raw-ping retention |
| `RETENTION_INTERVAL` | `3600000` | Maintenance interval in ms |
| `RETENTION_RAW_PINGS_DAYS` | `7` | Days of raw pings to keep |
| `RETENTION_KEEP_HOURLY_DAYS` | `0` | Days of hourly rollups to keep (`0` = forever) |
| `TIME_SERIES` | `false` | Store raw pings in a MongoDB time-series collection (requires MongoDB 6.0+) |

### Long-term tracking
Raw pings are kept for `retention.rawPingsDays` (default: 7) and continuously aggregated into hourly and daily rollups (min/max/avg player counts, capacity and uptime per server). The rollups are kept forever (`retention.keepHourlyDays` optionally trims the hourly level) and are served as JSON:

```
GET /api/history?unit=day&range=365d
GET /api/history?unit=hour&range=7d
```

### MongoDB time-series storage (opt-in)
On MongoDB 6.0+ you can set `"timeSeries": true` in `config.json` to store raw pings in a time-series collection (significantly smaller storage footprint, raw retention via TTL instead of periodic deletes). Enabling it later is cheap because raw pings are short-lived and all long-term data lives in the rollup collections: stop Minetrack, rename or drop the `pings` collection, set the flag, start again.

## Docker
Minetrack can be built and run with Docker from this repository in several ways:

### Build and deploy directly with Docker
```
# build image with name minetrack and tag latest
docker build . --tag minetrack:latest

# start container, delete on exit
# publish container port 8080 on host port 80
# pass MONGO_URI if logToDatabase is enabled
docker run --rm --publish 80:8080 --env MONGO_URI=mongodb://host:27017/minetrack minetrack:latest
```

The published port can be changed by modifying the parameter argument, e.g.:  
* Publish to host port 8080: `--publish 8080:8080`  
* Publish to localhost (thus prohibiting external access): `--publish 127.0.0.1:8080:8080`

### Build and deploy with docker-compose
```
# build and start service
docker-compose up --build

# stop service and remove artifacts
docker-compose down
```

## Nginx reverse proxy
The following configuration enables Nginx to act as reverse proxy for a Minetrack instance that is available at port 8080 on localhost:
```
server {
    server_name minetrack.example.net;
    listen 80;
    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
    }
}
```
