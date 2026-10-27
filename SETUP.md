# EverStone Hub — setup (about 20 minutes, one time)

You'll set up two free things:

- **GitHub Pages** hosts the app itself.
- **Cloudflare** keeps your data in sync and sends the reminders.

Then you connect your computer and your phone.

What's in this folder:

| Item | What it is |
|---|---|
| `app/` | The app. Upload everything inside this folder to GitHub. |
| `worker/worker.js` | The reminder and sync service. You paste this into Cloudflare. |
| `starter-data.json` | Your vendor contacts. You import this into the app once. Do **not** upload it to GitHub. |

---

## Part 1 — Put the app on GitHub Pages

1. On github.com, click **New repository**.
   - Name it `everstone-hub`.
   - Make it **Public**. Free GitHub Pages needs a public repo. Your data never goes in the repo, only the app code.
   - Click **Create repository**.
2. Click **uploading an existing file**. Drag in everything **inside** the `app` folder:
   - `index.html`, `sw.js` and `manifest.webmanifest`
   - the four `.png` icons
3. Click **Commit changes**.
4. Go to the repo's **Settings → Pages**.
   - Under *Build and deployment*, set Source to **Deploy from a branch**.
   - Pick Branch **main**, folder **/ (root)**, then click **Save**.
5. Wait 1–2 minutes. Your app is now live at:
   `https://YOUR-GITHUB-NAME.github.io/everstone-hub/`

## Part 2 — Set up the Cloudflare reminder service

1. Create a free account at **dash.cloudflare.com/sign-up**.
2. **Make the storage.** In the left menu, open **Storage & Databases → KV**.
   - Click **Create**.
   - Name it `everstone-hub`, then click **Add**.
3. **Make the Worker.** In the left menu, open **Compute (Workers) → Workers & Pages**.
   - Click **Create → Create Worker** (the "Hello World" starter).
   - Name it `everstone-hub-api`, then click **Deploy**.
4. Click **Edit code**.
   - Delete everything in the editor.
   - Paste in all of `worker/worker.js`.
   - Click **Deploy**.
5. **Connect the storage.** Go to your Worker's **Settings → Bindings**, then click **Add**.
   - Choose **KV namespace**.
   - Set Variable name to `HUB`. It must be exactly that.
   - Pick the `everstone-hub` namespace, then click **Deploy**.
6. **Set your access key.** This is the password your devices use to connect.
   - Open your app from Part 1, then go to **Settings**.
   - Tap **Make me an access key** and copy the key.
   - Back in Cloudflare, go to **Settings → Variables and Secrets** and click **Add**.
   - Set Type to **Secret**, Name to `ACCESS_KEY`, and paste the key as the value. Click **Deploy**.
   - Save the key somewhere safe, like your password manager.
7. *(Optional)* In the same place, add a **Text** variable named `CONTACT`. Set its value to your app address from Part 1. Apple's notification service likes having a real address on file.
8. **Turn on the reminder clock.** Go to **Settings → Trigger Events**, then click **Add → Cron Triggers**.
   - Enter `*/15 * * * *`. That means "every 15 minutes."
   - Click **Add**.
9. Copy your Worker address from the Worker's overview page. It looks like:
   `https://everstone-hub-api.YOUR-NAME.workers.dev`
   Open it in a browser. If you see `"kv":true,"key":true`, everything is wired up.

## Part 3 — Connect your devices

**On your computer (do this first):**

1. Open your app address from Part 1.
2. Load your data:
   - **New start:** go to **Settings → Import backup** and choose `starter-data.json`. This loads your vendor contacts.
   - **Keep what you already entered in the old hub file:** open that old file, go to **Settings → Export backup**, then import that export into the new app instead.
3. In **Settings**, paste your Worker address and access key, then click **Connect**.

**On your iPhone:**

1. Open your app address in **Safari**. Tap **Share → Add to Home Screen → Add**.
2. Open **EverStone** from the new home-screen icon. Notifications only work when you open it from the icon.
3. Go to **Settings**, paste the same Worker address and access key, then tap **Connect**.
   - When it asks, choose **Use cloud data**.
4. Tap **Turn on notifications**, then tap **Allow**.
5. Tap **Send test notification**. You should get one within a few seconds.

## How reminders work

- **Daily summary.** Every morning at 7:30 AM you get one notification. It covers overdue and today's tasks for EverStone and Realtor, plus crew dates, showings and client follow-ups. Change the time in Settings.
- **Timed reminders.** Give a task a **reminder time** and you get a separate alert at that time. You can also have it come 15 minutes to 2 hours early.
- **Timing.** Reminders arrive within 15 minutes of the time you set, because the service checks every 15 minutes.

## Good to know

- **Cost.** Everything here fits Cloudflare's free plan. Each change you make is one save. The free plan allows 1,000 saves a day, far more than you'll use.
- **Updating the app later.** Upload the new `index.html` to GitHub, replacing the old one. Your phone picks it up the next time you open the app.
- **Lost phone, or a new device?** Connect the new device with the same address and key. To cut off a device, change `ACCESS_KEY` in Cloudflare and reconnect your own devices with the new key.
