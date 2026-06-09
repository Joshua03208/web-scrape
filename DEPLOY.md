# Deploying the price scraper to a server (nginx + pm2 + certbot)

Target setup: existing Ubuntu/Debian server already running nginx, certbot and pm2,
app on port **3117**, domain **vxl.lol**.

> **Read this first — security.** The dashboard has **no login of its own**, it can
> trigger crawls, and it stores your dealer usernames/passwords in its database and
> shows them in the Sites tab. Never expose it to the internet without the nginx
> basic-auth step below. The app itself only listens on 127.0.0.1, so nothing can
> reach it except nginx — keep it that way.

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

## 4. Password-protect it (do not skip)

```bash
sudo apt install apache2-utils   # if htpasswd is missing
sudo htpasswd -c /etc/nginx/.htpasswd-scraper josh
```

It will prompt for the password you'll use to open the dashboard.

## 5. nginx site

`/etc/nginx/sites-available/vxl.lol`:

```nginx
server {
    listen 80;
    server_name vxl.lol;

    auth_basic           "Price scraper";
    auth_basic_user_file /etc/nginx/.htpasswd-scraper;

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

Certbot rewrites the server block for HTTPS and sets up renewal. Basic auth over
plain HTTP sends the password in cleartext, so do this straight away.

Done — https://vxl.lol opens the dashboard after the basic-auth prompt.

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
