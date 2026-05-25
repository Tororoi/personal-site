import { motion } from 'motion/react'
import { Link } from 'react-router-dom'
import styles from './Blog.module.css'

export function Blog() {
  return (
    <main className={styles.blog}>
      <div className="container">
        <motion.div
          className={styles.header}
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <h1 className={styles.title}>Blog</h1>
          <p className={styles.description}>
            Thoughts on web development, design, and creative coding.
          </p>
        </motion.div>

        <div className={styles.comingSoon}>
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.3, duration: 0.6 }}
            className={styles.comingSoonCard}
          >
            <h2>Coming Soon</h2>
            <p>
              I'm currently setting up my blog. Check back soon for articles on
              web development, tutorials, and project insights!
            </p>
            <Link to="/" className={styles.backBtn}>
              ← Back to Home
            </Link>
          </motion.div>
        </div>
      </div>
    </main>
  )
}
