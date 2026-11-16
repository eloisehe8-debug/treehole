# 树洞 Treehole

An anonymous place to share what's weighing on you and to listen to others. 匿名倾诉、匿名倾听。

- Sign in with an email link. Other people only ever see a random nickname like `tree#0382`.
- Post with a mood tag, reply to others ("Listen").
- Rate any post or reply anonymously (helpful / not helpful + an optional one-line comment).
- Report harmful content anonymously. Admins see reports and can hide content, ban authors, and mark reports resolved.
- Chinese / English switch. Crisis hotlines at the bottom of every page.
- Flood control: at most 5 posts and 20 replies per user every 10 minutes.

Static front end (`index.html`, `style.css`, `app.js`, `i18n.js`, `config.js`) on GitHub Pages; data, login and permissions on Supabase (`supabase/schema.sql`).

## Setup

### 1. Supabase
1. Create a free account at https://supabase.com and click **New project**. Pick region **Northeast Asia (Tokyo)** or **Southeast Asia (Singapore)**: they're reasonably close to both mainland China and the US West Coast.
2. Open **SQL Editor → New query**, paste all of `supabase/schema.sql`, and click **Run**.
3. Open **Project Settings → API**. Copy the **Project URL** and the **anon public** key into `config.js`. The anon key is safe to publish; the database rules decide what it can do. **Never** put the `service_role` key in this project.
4. Open **Authentication → URL Configuration**. Set **Site URL** to your GitHub Pages address (e.g. `https://YOUR_NAME.github.io/treehole/`) and add the same address under **Redirect URLs**.
5. Supabase's built-in email sender only sends a few emails per hour. Before inviting real users, set up custom SMTP under **Authentication → Emails → SMTP Settings**. Resend or Brevo both have free tiers.

### 2. Make yourself admin
Sign in on the site once. Then run this in the SQL Editor:
```sql
update public.profiles set is_admin = true
  where id = (select id from auth.users where email = 'YOUR_EMAIL');
```
Reload the site. The **Open reports** panel appears for you only.

### 3. GitHub Pages
1. Create a new public repository named `treehole` on github.com.
2. Push this folder to it (see below).
3. In the repo, go to **Settings → Pages**, set **Source** to *Deploy from a branch*, and pick branch `main` and folder `/ (root)`.
4. The site goes live at `https://YOUR_NAME.github.io/treehole/` in about a minute.

## Notes
- Mainland China: GitHub Pages and Supabase can be slow or blocked without a VPN. Serving users there reliably needs a mainland host and an ICP filing (备案).
- Moderation: anonymous emotional-support spaces attract abuse. Check the reports panel often.
- Check the hotline numbers in `index.html` and `i18n.js` before launch, and add lines for wherever your users are.
