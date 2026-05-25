export interface BlogPost {
  slug: string
  title: string
  date: string
  excerpt: string
  tags: string[]
  author: string
  image: string
  featured?: boolean
  content?: string
}

export interface BlogFrontmatter {
  title: string
  slug: string
  date: string
  excerpt: string
  tags: string[]
  author: string
  image: string
  featured?: boolean
}

// This will be populated by importing MDX files
export const blogPosts: BlogPost[] = []

export function getAllBlogPosts(): BlogPost[] {
  return blogPosts.sort((a, b) => {
    return new Date(b.date).getTime() - new Date(a.date).getTime()
  })
}

export function getFeaturedBlogPosts(): BlogPost[] {
  return blogPosts
    .filter((post) => post.featured)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
}

export function getBlogPostBySlug(slug: string): BlogPost | undefined {
  return blogPosts.find((post) => post.slug === slug)
}

export function getBlogPostsByTag(tag: string): BlogPost[] {
  return blogPosts
    .filter((post) => post.tags.includes(tag))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
}

export function getAllTags(): string[] {
  const tags = new Set<string>()
  blogPosts.forEach((post) => {
    post.tags.forEach((tag) => tags.add(tag))
  })
  return Array.from(tags).sort()
}

export function formatDate(dateString: string): string {
  const date = new Date(dateString)
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

export function calculateReadingTime(content: string): string {
  const wordsPerMinute = 200
  const wordCount = content.trim().split(/\s+/).length
  const minutes = Math.ceil(wordCount / wordsPerMinute)
  return `${minutes} min read`
}
