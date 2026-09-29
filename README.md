# Dash Clock Photos

A private, self-hosted photo frame inspired by [DashClock](https://github.com/nikunjsingh93/dash_clock) and an ambient smart display. Full-screen photos rotate behind a large clock, date, and current temperature. Each login sees only its own folder on your Ubuntu server's HDD. DashClock is a browser-side Angular PWA; this project adds a separate Node server for accounts and protected photo delivery. The Docker/GHCR deployment follows the pattern used by [OnDevice Film Lab](https://github.com/nikunjsingh93/ondevice-film-lab).

## MVP features

- Full-screen photo slideshow with shuffle/newest order, interval, pause, next/previous, and keyboard controls.
- Current time and date in the selected city's time zone, with 12/24-hour choice.
- Current temperature from [Open-Meteo](https://open-meteo.com/en/docs), cached by the backend for 15 minutes. City search uses [Open-Meteo geocoding](https://open-meteo.com/en/docs/geocoding-api). Weather needs internet access from the container; photos and account data stay on your server.
- Administrator-created accounts. Each account maps to `/photos/<username>` and photo URLs require that account's signed login cookie. The HDD is mounted read only. Account deletion leaves photos on disk.
- Docker Compose for local builds; a separate Portainer stack for the image published to GitHub Container Registry.

## Ubuntu setup

1. Choose an **already mounted** HDD path, for example `/mnt/hdd/dash-clock-photos`. Create the root, safety marker, and one folder for each account:

   ```bash
   sudo mkdir -p /mnt/hdd/dash-clock-photos/admin
   sudo touch /mnt/hdd/dash-clock-photos/.dash-clock-photos
   sudo chmod -R a+rX /mnt/hdd/dash-clock-photos
   ```

   Put photos in `admin/` or its subfolders. Supported formats are JPG/JPEG, PNG, WebP, AVIF, and GIF. HEIC/RAW need conversion to a browser-supported format. The marker makes the app refuse to start when the expected drive content is absent. Also ensure the HDD itself is mounted before starting Docker; use an Ubuntu mount unit or `/etc/fstab`.

2. Create state storage on the Ubuntu SSD or another local Linux filesystem. The container runs as UID/GID `10001`:

   ```bash
   sudo mkdir -p /var/lib/dash-clock-photos
   sudo chown 10001:10001 /var/lib/dash-clock-photos
   ```

3. Copy `.env.example` to `.env`. Set `DASH_PHOTOS_PATH`, `DASH_STATE_PATH`, and a unique `DASH_ADMIN_PASSWORD` of at least 12 characters. The password is used **only to create the first account**; after that, change it in the app and remove or replace the bootstrap value in your deployment secrets. Existing account state lives in `/state/users.json`.

4. In this project folder:

   ```bash
   docker compose up -d --build
   docker compose logs -f dash-clock-photos
   ```

   Open `http://UBUNTU-IP:3080`, sign in, and set your city in Settings. The health endpoint is `/api/health`.

To add another account, sign in as admin and use **Settings → Accounts**. Then create the matching folder on the HDD, for example `/mnt/hdd/dash-clock-photos/alex`, and copy photos into it. Use **Refresh** in Settings to rescan without restarting.

## New GitHub repository and image

This folder is an independent project. Create an empty GitHub repository named `dash-clock-photos` under `nikunjsingh93`, then push the `main` branch. The included workflow builds and pushes `ghcr.io/nikunjsingh93/dash-clock-photos:latest` on each push to `main`. The GitHub package may initially be private; make it public in package settings or give your Ubuntu/Portainer host GHCR credentials.

For Portainer, add a Git stack pointing at this repository, branch `main`, Compose path `compose.prod.yaml`, and set the same five `DASH_*` variables from `.env.example`. The production stack pulls the GHCR image. To update after a push, pull and redeploy with image re-pull enabled. If you rename the GitHub repository, update the `image:` in `compose.prod.yaml`.

## Local development

Node 22+ is enough; there are no runtime packages to install. Create local `photos/admin` and `state` directories, add `photos/.dash-clock-photos`, then set `ADMIN_USERNAME=admin` and `ADMIN_PASSWORD` to a 12+ character value and run `npm start`. On PowerShell, set those environment variables with `$env:ADMIN_USERNAME='admin'` and `$env:ADMIN_PASSWORD='...'` first. Run `npm test` for the API isolation checks.

## Security and backups

Use this directly on a trusted LAN only. For remote access, put it behind HTTPS (for example Tailscale Serve or an HTTPS reverse proxy), set `COOKIE_SECURE=true`, and avoid public port forwarding. User passwords are salted with scrypt; cookies are signed and HTTP-only. Back up `/var/lib/dash-clock-photos` along with the HDD folders. Keep `.env` out of Git. The photo drive is never writable by the container.

The app reads up to 10,000 photo records per account per refresh. This MVP scans folders on demand and serves originals; very large libraries or high-resolution RAW workflows would benefit from thumbnails and an index in a later version.
