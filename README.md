# Thomas Cantwell - Portfolio & Blog

A modern, performant portfolio website built with React, TypeScript, and Vite, featuring glassmorphism design and a custom MDX-powered blog.

## 🚀 Features

- **Modern Tech Stack**: React 19, TypeScript, Vite 8
- **Glassmorphism Design**: Beautiful frosted glass effects with ambient gradients
- **Smooth Animations**: Framer Motion for page transitions and micro-interactions
- **Custom Blog**: MDX-powered blog with markdown and React component support
- **Fully Responsive**: Mobile-first design that works on all devices
- **SEO Optimized**: Proper meta tags, semantic HTML, and performance optimized
- **Netlify Forms**: Built-in contact form with Netlify integration
- **Type-Safe**: Full TypeScript coverage for better DX

## 📦 Tech Stack

### Core
- **React** 19.2 - UI library
- **TypeScript** 5.9 - Type safety
- **Vite** 8.0 - Build tool and dev server
- **React Router** 7.13 - Client-side routing

### Styling & Animation
- **CSS Modules** - Scoped component styles
- **Framer Motion** 12 - Animations and transitions
- **CSS Custom Properties** - Design tokens and theming

### Blog & Content
- **MDX** 3.1 - Write JSX in markdown
- **Remark GFM** - GitHub Flavored Markdown support
- **Rehype Highlight** - Syntax highlighting for code blocks

### UI & Icons
- **React Icons** - Icon library
- **React Helmet Async** - Dynamic meta tags for SEO

## 🛠️ Getting Started

### Prerequisites

- Node.js 20+ 
- npm

### Installation

\`\`\`bash
# Install dependencies
npm install --legacy-peer-deps

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
\`\`\`

## �� Adding Blog Posts

Create a new \`.mdx\` file in \`src/content/blog/\`:

\`\`\`mdx
---
title: "Your Post Title"
slug: "your-post-slug"
date: "2026-02-09"
excerpt: "A brief description"
tags: ["react", "typescript"]
author: "Your Name"
image: "/images/blog/post.jpg"
featured: true
---

# Your Post Title

Your content here!
\`\`\`

## 🎨 Customization

### Design Tokens

Edit \`src/styles/variables.css\` to customize colors, typography, spacing, etc.

### Projects

Update \`src/data/projects.json\` to add/edit projects.

## 🚀 Deployment to Netlify

1. Push code to GitHub
2. Connect repository to Netlify
3. Build settings are configured in \`netlify.toml\`
4. Deploy!

Build command: \`npm run build\`  
Publish directory: \`dist\`

## 📧 Contact Form

The contact form uses Netlify Forms. Form submissions will appear in your Netlify dashboard.

## 🎯 Future Enhancements

- [ ] Blog search functionality
- [ ] Tag filtering for blog posts
- [ ] Dark/light mode toggle
- [ ] Mobile navigation menu
- [ ] RSS feed generation
- [ ] Sitemap generation

---

Built with ❤️ by Thomas Cantwell
