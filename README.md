# Personal Assistant — Setup Guide

Your own private AI assistant, opened from an icon on your iPhone (or by saying "Hey Siri"). It runs on a small server that only your own devices can reach, so it works anywhere without your Mac being on.

**What it can do**
- **Home screen** with a live clock dial, a countdown to your next reminder, weather, the date, and a Talk button
- **Chat** in plain language, by typing or talking
- **Gmail**: summaries, drafts, and sending after you approve
- **Calendars** (Apple iCloud and Gmail): see your schedule and add or move events
- **To-do lists** for work and personal life
- **Memory** of things you tell it about yourself
- **Reminders** that pop up on your phone at the time you ask
- **Morning brief** on weekdays and a **weekly review**, sent as notifications
- **Photos and PDFs**: read them, summarize them, and log receipts as expenses
- **Spending** totals by category
- **Routines**: repeatable checklists that land on your to-do list on schedule (for example, every month on the 5th)
- **Hey Siri**: talk to it hands-free and hear the answer

**Time:** about an hour, once. **You'll need:** your iPhone (iOS 16.4 or newer), your Mac, and a credit card.

**Monthly cost:** roughly $6 for the server, $0 for Tailscale (free personal plan), and pay-as-you-go for Claude (usually a few dollars a month for personal use; you set a hard limit).

---

## How your data stays private

- The app lives on **your own server**. Your to-dos, memories, reminders, expenses and chat history sit in one file there.
- The server is **invisible to the public internet**. Only devices signed in to *your* Tailscale account can reach it, and it also asks for your passcode (or a private key, for Siri).
- What leaves your server:
  - Each message, photo or PDF you send goes to Anthropic so Claude can answer. API messages aren't used to train models by default.
  - Notifications pass through Apple's push service. They're encrypted so only your phone can read them.
- Photos and PDFs you send are read once and **not stored**. Only what you ask it to log is kept, such as an expense.
- The code on GitHub contains **no personal data, keys, or passwords**. Those are typed straight into your server during setup.

---

## Step 1 — Get a Claude API key (5 min)

1. On your Mac, go to **console.anthropic.com** and sign up.
2. Go to **Billing** and add a small amount of credit (for example $10).
3. Still in Billing, set a **monthly spend limit** (for example $20) so it can never surprise you.
4. Go to **API Keys → Create Key**. Name it `assistant`. Copy the key (it starts with `sk-ant-`).
5. Paste it temporarily into a Notes note. You'll need it in Step 5, then delete the note.

## Step 2 — Install Tailscale on your iPhone (3 min)

1. Install **Tailscale** from the App Store.
2. Open it and sign in (Sign in with Apple or Google is easiest). **Remember which account you used** — you'll use the same one in Step 5.
3. Allow it to add a VPN configuration when asked.
4. In Tailscale's settings, turn on **VPN On Demand**, so it stays connected and the app, notifications and Siri always work.

## Step 3 — Put the app code on GitHub (8 min)

1. Unzip `kai-assistant.zip` on your Mac. You'll get a folder called `kai-assistant`.
2. Go to **github.com** and create a free account.
3. Click **+** (top right) → **New repository**.
   - Repository name: `assistant-app`
   - Choose **Public**. It's only code with nothing personal in it, and this lets your server download it without extra passwords.
   - Click **Create repository**.
4. On the next page, click the link **uploading an existing file**.
5. Open the `kai-assistant` folder in Finder, select **everything inside it** (Cmd+A), and drag it onto the GitHub page. Make sure the `static` folder is included.
6. Click **Commit changes** at the bottom.

## Step 4 — Create your server (7 min)

1. Go to **digitalocean.com** and sign up.
2. Click **Create → Droplets**.
3. Choose:
   - **Region:** San Francisco
   - **Image:** Ubuntu, the newest **LTS** version
   - **Size:** Basic → Regular → the cheapest option with **1 GB** memory
   - **Authentication:** Password — create a strong one and save it in your password manager
   - **Hostname:** `assistant`
4. Optional but recommended: tick **Backups** (a small extra monthly cost).
5. Click **Create Droplet** and wait about a minute until it's ready.

## Step 5 — Install the assistant (10 min)

1. Click your new droplet, then click **Console** (top right). A black terminal window opens in your browser.
2. Copy this command, **change both `YOUR-GITHUB-NAME`s** to your GitHub username, paste it in the console and press Return:

   ```
   curl -fsSL https://raw.githubusercontent.com/YOUR-GITHUB-NAME/assistant-app/main/setup.sh | sudo bash -s YOUR-GITHUB-NAME/assistant-app
   ```

3. Answer the questions it asks:
   - **API key:** paste your key from Step 1. Nothing shows on screen while you paste — that's normal. Press Return.
   - **Passcode:** make up a passcode for the app (8+ characters, no `'` or `\`) and type it twice.
   - **Your name:** what the assistant should call you.
   - **Assistant's name:** press Return to keep **Jarvis**, or type another name.
   - **Tailscale link:** a `https://login.tailscale.com/...` link appears. Open it, sign in with the **same account as your iPhone**, and click **Connect**.
   - **HTTPS link (sometimes):** if it asks you to enable HTTPS, open that link, click **Enable**, and come back.
4. When you see **All done!**, it shows your address, like `https://assistant.tail1234.ts.net`. Write it down.
5. Delete the API key from your Notes app.

## Step 6 — Add it to your iPhone home screen (2 min)

1. Make sure **Tailscale is connected**.
2. Open **Safari** and go to your address from Step 5.
3. Enter your passcode.
4. Tap the **Share** button → **Add to Home Screen** → **Add**.

From now on, open it from the new icon on your home screen (not from Safari).

## Step 7 — Turn on notifications (1 min)

1. Open the app **from the home screen icon**.
2. Tap **More** (bottom right) → **Turn on notifications** → **Allow**.
3. Tap **Send a test**. A notification should pop up within a few seconds.

On the same screen, you can set your **morning brief** time (weekdays at 7:30 AM to start) and your **weekly review** (Mondays at 8:00 AM to start). You can also just tell it in chat, for example "Move my morning brief to 6:45."

## Step 8 — Set up "Hey Siri" (5 min)

1. In the app, tap **More** → under **Siri**, tap **Copy** to copy your private key. Keep the app open so you can see the **Shortcut address** shown just below it.
2. Open the **Shortcuts** app → tap **+** to make a new shortcut. Name it **Jarvis** (or your assistant's name). This is the phrase you'll say to Siri.
3. Add these actions in order (use the search bar at the bottom):
   1. **Dictate Text.** Tap it and set "Stop Listening" to **After Pause**.
   2. **Get Contents of URL.**
      - URL: the **Shortcut address** from the More screen.
      - Tap the arrow to show more options and set **Method** to **POST**.
      - **Headers:** add one. Key `Authorization`, value `Bearer ` followed by your key. Type "Bearer", one space, then paste the key.
      - **Request Body:** choose **JSON**, add a **Text** field. Key `message`, and for the value tap and choose the **Dictated Text** variable.
   3. **Speak Text.** Make sure it's speaking **Contents of URL**.
4. Tap **Done**.

Now say **"Hey Siri, Jarvis"**, wait for the listening sound, and talk. For example: "remind me at 5 to pick up the dry cleaning," or "what's on my work list today?" It answers out loud. It works from your AirPods too.

---

## Connect Apple Calendar (iCloud) (about 3 min)

Your iPhone saves new events to iCloud, so this is the calendar Jarvis adds to by default.

1. On your Mac, go to **account.apple.com** and sign in with your Apple ID.
2. Open **Sign-In and Security** → **App-Specific Passwords** → **＋** (or "Generate an app-specific password").
3. Name it `Jarvis` and click **Create**. Copy the password it shows (it looks like `abcd-efgh-ijkl-mnop`). You won't be able to see it again.
4. In Jarvis → **More → Apple Calendar (iCloud)**, enter your **Apple ID email** and paste that password → **Connect iCloud Calendar**.
5. Under **New events go to**, pick the calendar you normally use.

This app-specific password only works for things like calendars. It can't sign in to your Apple account or change your password. You can revoke it anytime in the same place.

---

## Connect your Gmail accounts (about 25 min, once)

These are the same Gmail accounts and calendars you see in Apple Mail and Apple Calendar, so anything Jarvis adds shows up there too. This lets Jarvis read and summarize your email, write drafts, send email **only after you approve it**, and see and add to your calendar. You're creating your own private Google "app" that only you use. Google calls this an "unverified app", which is normal for something personal like this.

Do this on your Mac in Chrome. You only create the Google setup once (steps A–D), using either of your Gmail accounts, and then connect both accounts in step E.

**A. Create the project**
1. Go to **console.cloud.google.com**. Accept the terms if asked.
2. Click the project picker at the top left → **New project**. Name it `Jarvis` → **Create**. Make sure `Jarvis` is selected at the top.

**B. Turn on Gmail and Calendar**
3. In the search bar at the top, type **Gmail API**, open it and click **Enable**.
4. Search **Google Calendar API**, open it and click **Enable**.

**C. Set up the sign-in screen**
5. Search **Google Auth Platform** and open it → **Get started**.
   - App name: `Jarvis`. Support email: your Gmail. → **Next**
   - Audience: **External** → **Next**
   - Contact email: your Gmail → **Next** → tick the agreement → **Create**
6. Go to **Audience** in the left menu → under Publishing status click **Publish app** → **Confirm**. It should say **In production**. Skip this and Google disconnects Jarvis every 7 days.

**D. Create the key Jarvis uses**
7. Go to **Clients** in the left menu → **Create client**.
   - Application type: **Web application**. Name: `Jarvis`.
   - Under **Authorized redirect URIs** click **Add URI** and paste the address shown in Jarvis → **More → Gmail & Google Calendar → Setup details**. It looks like `https://assistant.xxxx.ts.net/api/google/callback`.
   - Click **Create**.
8. A box shows your **Client ID** and **Client secret**. Keep it open, or download the JSON.

**E. Connect**
9. In Jarvis → **More → Gmail & Google Calendar → Setup details**, paste the **Client ID** and **Client secret** → **Save**.
10. Tap **＋ Add Gmail account** and choose your first Gmail account.
11. Google shows **"Google hasn't verified this app."** That's your own app, so tap **Advanced** → **Go to Jarvis (unsafe)**.
12. On the permissions screen, **tick every box** → **Continue**. You'll see **Google connected**. Tap **Back to Jarvis**.
13. Tap **＋ Add Gmail account** again and repeat steps 10–12 with your second Gmail account. (You can add more later the same way.)
14. Optional: pick an account in the dropdown and tap **Make default** for the account you want new events and emails to use unless you say otherwise.

**Try it:** "What important emails did I get today?", "What's on my calendar tomorrow?", "Add dentist Friday at 3pm", "Draft a reply to June saying I'll have it by Thursday."

**How sending works:** Jarvis always writes a draft first and shows you the whole email. It can only send after you reply "send it", and the server enforces that. Jarvis never sends calendar invites to other people. You can disconnect anytime in **More**, or at **myaccount.google.com/permissions**.

---

## Things to try

- "Remind me tomorrow at 9 to send the report."
- "Add *call mom* to my personal list for Saturday."
- Tap **＋**, take a photo of a receipt: "log this."
- Attach a PDF: "summarize this in 5 bullets."
- "Make a monthly routine on the 5th for my month-end close: pull reports, reconcile, send summary. Make them due 2 days later."
- "How much did I spend on groceries this month?"
- "Remember that I work from home on Wednesdays and Fridays."
- Tap the Weather panel on Home (or say "set my weather city to Irvine, CA") to show your local weather.
- Tap **🎙** and just talk. When you use the mic, it answers out loud. You can also turn on **Speak replies out loud** in More.

## Updating to a new version

When new code is ready, upload the changed files to your GitHub repository the same way as Step 3 (GitHub replaces files with the same name), then run the **same command** from Step 5 in the droplet console. Your data, passcode and key are kept.

## If something goes wrong

| What you see | What to do |
|---|---|
| The page won't load on your iPhone | Open the Tailscale app and make sure it's connected. |
| "Wrong passcode" | Check caps. After 5 wrong tries it locks for 15 minutes. |
| No "Turn on notifications" button | Open the app from the **home screen icon**, not Safari. Needs iOS 16.4 or newer. |
| Test notification never arrives | iPhone **Settings → Notifications →** your app → make sure **Allow Notifications** is on, and Focus/Do Not Disturb isn't hiding it. |
| Siri says it couldn't connect | Make sure Tailscale is connected (turn on VPN On Demand). Check the URL and that the header says `Bearer ` + your key. |
| 🎙 button just shows a tip | Your iPhone doesn't allow speech recognition inside web apps. Use the 🎤 on your keyboard, or Hey Siri. |
| "The API key was rejected" | In the droplet console run `sudo nano /etc/assistant.env`, fix the key between the quotes, save (Ctrl+O, Return, Ctrl+X), then run `sudo systemctl restart assistant`. |
| "Check your Anthropic account billing" | Add credit at console.anthropic.com. |
| Anything else | In the droplet console run `journalctl -u assistant -n 50` and show the output to Claude. |

Backups of your data are saved every day on the server (last 14 days kept) in `/var/lib/assistant/backups`.

## Coming next

- Apple (iCloud) Calendar
- Bank CSV import and budgets
