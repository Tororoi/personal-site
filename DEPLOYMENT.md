# Deployment Guide for Netlify

## Quick Deploy to Netlify

### Option 1: Deploy via GitHub (Recommended)

1. **Push your code to GitHub**
   ```bash
   git add .
   git commit -m "Complete portfolio redesign with React and MDX blog"
   git push origin staging
   ```

2. **Connect to Netlify**
   - Go to [Netlify](https://app.netlify.com/)
   - Click "Add new site" → "Import an existing project"
   - Choose "Deploy with GitHub"
   - Select your repository: `Tororoi/personal-site`
   - Select branch: `staging` (or `main`)

3. **Configure Build Settings** (should auto-detect from `netlify.toml`)
   - Build command: `npm run build`
   - Publish directory: `dist`
   - Click "Deploy site"

4. **Configure Domain** (Optional)
   - In Site settings → Domain management
   - Add custom domain if you have one
   - Netlify will handle SSL certificates automatically

### Option 2: Deploy via Netlify CLI

```bash
# Install Netlify CLI globally
npm install -g netlify-cli

# Login to Netlify
netlify login

# Deploy (from project root)
netlify deploy --prod

# Follow the prompts:
# - Create & configure new site
# - Build command: npm run build
# - Publish directory: dist
```

## Post-Deployment Checklist

### 1. Enable Netlify Forms
- Go to Site settings → Forms
- Enable form notifications
- Set up email notifications for contact form submissions

### 2. Configure Environment Variables (if needed)
- Site settings → Build & deploy → Environment
- Add any API keys or environment variables

### 3. Set Up Redirects
The `_redirects` file in `public/` handles SPA routing. Verify:
- All routes work on page refresh
- No 404 errors on direct navigation

### 4. Test the Site
- ✅ Test all navigation links
- ✅ Test contact form submission
- ✅ Verify projects load correctly
- ✅ Check mobile responsiveness
- ✅ Test on different browsers
- ✅ Verify images load properly

### 5. Set Up Deploy Previews
- Branch deploys are automatic for connected GitHub repos
- Preview changes before merging to production
- Each PR gets a unique preview URL

## Continuous Deployment

Once connected to GitHub:
- **Automatic deploys** on push to production branch
- **Deploy previews** for all pull requests
- **Instant rollbacks** from Netlify dashboard

## Monitoring

### Netlify Analytics (Optional Paid Feature)
- Real-time visitor analytics
- Page views and unique visitors
- No JavaScript required (server-side)

### Alternative: Google Analytics
Add tracking code to `index.html` if preferred

## Troubleshooting

### Build Fails
```bash
# Test build locally first
npm run build

# Check for TypeScript errors
npm run lint

# Clear cache and rebuild
rm -rf node_modules package-lock.json
npm install --legacy-peer-deps
npm run build
```

### Form Not Working
- Verify hidden form in `index.html`
- Check form `name` attribute matches in both places
- Enable forms in Netlify dashboard

### 404 on Refresh
- Verify `_redirects` file is in `public/` folder
- Check Netlify build logs to ensure it's copied to `dist/`

## Performance Optimization

### Already Configured ✅
- Vite build optimization
- Code splitting
- Asset optimization
- Brotli/Gzip compression (automatic on Netlify)

### Optional Enhancements
- **Preload critical assets** in `index.html`
- **Lazy load images** using native `loading="lazy"`
- **Add service worker** for offline support
- **Optimize images** to WebP format

## Custom Domain Setup

1. **Purchase domain** (Namecheap, Google Domains, etc.)

2. **Add to Netlify**
   - Site settings → Domain management
   - Add custom domain
   - Follow DNS configuration instructions

3. **Configure DNS** (at your domain provider)
   ```
   Type: A
   Name: @
   Value: 75.2.60.5

   Type: CNAME  
   Name: www
   Value: your-site-name.netlify.app
   ```

4. **Enable HTTPS** (automatic via Let's Encrypt)

## Monitoring & Maintenance

- **Monitor build logs** for warnings/errors
- **Check Netlify Functions** usage (if using serverless functions)
- **Review form submissions** regularly
- **Update dependencies** monthly for security patches

---

Need help? Check [Netlify Docs](https://docs.netlify.com/) or [contact support](https://www.netlify.com/support/).
