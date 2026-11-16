# 树洞 Treehole

匿名倾诉、匿名倾听的社区。说那些不方便和熟人讲的话。
An anonymous community for sharing what weighs on you and listening to others.

**网站 / Live site:** https://eloisehe8-debug.github.io/treehole/

## 功能

- **登录后才能进入**：邮箱验证码或登录链接。别人只看得到随机昵称（如 `tree#0382`），看不到邮箱。
- **匿名发布**：写心事、感悟或随笔，并选一个话题。
- **广场**：浏览所有人的树洞，可以按类型筛选，在评论区安慰、交流。
- **话题社区**：情绪话题（难过、焦虑、生气、孤独、疲惫、开心）和生活话题（学业、工作、感情、家庭、友情、成长、身心健康、其他）。
- **匿名私聊**：在任何帖子或评论旁点「私信」，就能一对一聊天。每条消息都能举报，也可以屏蔽对方。
- **匿名评价与举报**：对帖子和评论点「有帮助 / 没帮助」并留一句话；举报骚扰、仇恨、广告或自伤风险。
- **管理面板**：管理员处理举报，可以隐藏内容、封禁作者。管理员只能看到被举报的那一条私信。
- **防刷屏**：每人 10 分钟内最多 5 条帖子、20 条评论、60 条私信。
- 中英文切换；每页底部有心理援助热线。

## Features

- Sign-in required (email code or magic link). Others see only a random nickname, never your email.
- Post anonymously as a secret, reflection or note, tagged with a topic.
- **Square**: browse and filter everyone's posts; comment to comfort and talk.
- **Topics**: browse by feeling or by area of life.
- **Private messages**: one-to-one anonymous chats started from any post or comment, with per-message reporting and blocking.
- Anonymous ratings and reports. Admins review reports, hide content and ban authors, and can read only the private messages that were reported.
- Flood control, Chinese/English switch, crisis hotlines on every page.

## 技术 / Stack

Static front end on GitHub Pages: `index.html`, `style.css`, `app.js`, `i18n.js`, `config.js`.
Database, login and permissions on Supabase: `supabase/schema.sql`, `supabase/002_communities.sql`.
Login emails are sent through Brevo SMTP.

## Setup

1. **Supabase**: create a project at https://supabase.com. In **SQL Editor**, run `supabase/schema.sql`, then `supabase/002_communities.sql`.
2. **Config**: copy the Project URL and the publishable (anon) key from **Project Settings → API Keys** into `config.js`. That key is meant to be public; the database rules decide what it can do. Never put the secret or `service_role` key in this repo.
3. **Auth URLs**: under **Authentication → URL Configuration**, set Site URL and Redirect URLs to your GitHub Pages address.
4. **Email**: under **Authentication → Emails → SMTP Settings**, add custom SMTP (for example Brevo: host `smtp-relay.brevo.com`, port `587`). Then edit the **Magic Link** template to include `{{ .Token }}` so emails carry a sign-in code. To use link-only emails instead, set `emailCode: false` in `config.js`.
5. **Admin**: sign in once, then run:
   ```sql
   update public.profiles set is_admin = true
     where id = (select id from auth.users where email = 'YOUR_EMAIL');
   ```
6. **GitHub Pages**: under **Settings → Pages**, deploy from branch `main`, folder `/ (root)`.

When you change `style.css` or any `.js` file, update the `?v=` numbers in `index.html` so browsers fetch the new files.

## 注意 / Notes

- **中国大陆**：GitHub Pages 和 Supabase 在大陆不稳定，不开 VPN 基本无法登录。要稳定服务大陆用户，需要国内服务器、ICP 备案，以及"后台实名"（手机号验证）。
  Mainland China: without a VPN, GitHub Pages and Supabase are unreliable. Serving users there needs a mainland host, an ICP filing and real-name (phone) verification.
- **内容管理**：匿名倾诉社区容易招来骚扰，请经常查看举报面板。
- 上线前请核对 `index.html` 和 `i18n.js` 里的热线号码，并补充你的用户所在地区的热线。
