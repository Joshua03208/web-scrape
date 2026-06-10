# Deploying the price scraper to a server (nginx + pm2 + certbot)

Target setup: existing Ubuntu/Debian server already running nginx, certbot and pm2,
app on port **3117**, domain **vxl.lol**.

> **Security note.** The dashboard has no login of its own. Without the optional
> basic-auth step below, anyone who finds the URL can browse your price data,
> trigger scrapes from your server, and — if you ever add a site with a dealer
> login — read those stored credentials in the Sites tab. Running without a
> password is only sensible while no dealer credentials are stored; add the
> auth step before you ever save one.

## 1. Get the code onto the server

```bash
cd /var/www
git clone https://github.com/<your-username>/web-scrape.git
cd web-scrape
```

Requires Node 20+ (`node -v` to check; use nodesource or nvm if it's older).

## 2. Install dependencies + the crawler browser

```bash
npm ci
npx playwright install --with-deps chromium
```

The `--with-deps` flag apt-installs the system libraries Chromium needs — it will
ask for sudo. This is a one-off per server.

## 3. Run it with pm2 on port 3117

```bash
PORT=3117 pm2 start src/index.js --name price-scraper
pm2 save
```

(`pm2 startup` once, if you haven't already, so it survives reboots.)

Check it's up: `curl http://127.0.0.1:3117/api/sites` should return JSON.

## 4. (Optional) password-protect it

Skip this if you're happy with the dashboard being public — see the security note
at the top. To enable it later:

```bash
sudo apt install apache2-utils   # if htpasswd is missing
sudo htpasswd -c /etc/nginx/.htpasswd-scraper josh   # you choose user + password here
```

then un-comment the two `auth_basic` lines in the nginx block below and reload nginx.

## 5. nginx site

`/etc/nginx/sites-available/vxl.lol`:

```nginx
server {
    listen 80;
    server_name vxl.lol;

    # un-comment to require a password (see step 4):
    # auth_basic           "Price scraper";
    # auth_basic_user_file /etc/nginx/.htpasswd-scraper;

    # parts-list uploads are capped at 10 MB by the app
    client_max_body_size 12m;

    location / {
        proxy_pass http://127.0.0.1:3117;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # runs take minutes; don't let nginx cut off slow API responses
        proxy_read_timeout 300s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/vxl.lol /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 6. HTTPS

```bash
sudo certbot --nginx -d vxl.lol
```

Certbot rewrites the server block for HTTPS and sets up renewal.

Done — https://vxl.lol opens the dashboard.

## Updating later

```bash
cd /var/www/web-scrape
git pull
npm ci
pm2 restart price-scraper
```

## Notes

- **Data lives in `data/scraper.db`** (created on first run, next to the code).
  It contains your sites, dealer credentials and all price history — back it up
  if you care about the history, and never commit it (it's gitignored).
- Runs are triggered manually from the dashboard. If you later want a scheduled
  nightly run, that's a small addition — ask.
- pm2 logs: `pm2 logs price-scraper`. The crawler is polite by design
  (2 concurrent pages, robots.txt respected, bounded page counts).
- The server needs outbound internet access to the supplier sites, and roughly
  500 MB free for Chromium.
