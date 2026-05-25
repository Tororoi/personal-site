import { motion } from 'motion/react'
import { ProjectGrid } from '../components/portfolio/ProjectGrid'
import styles from './Projects.module.css'

export function Projects() {
  return (
    <main className={styles.projects}>
      <div className="container">
        <motion.div
          className={styles.header}
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <h1 className={styles.title}>My Projects</h1>
          <p className={styles.description}>
            A collection of my work showcasing web applications, creative tools,
            and interactive experiences built with modern technologies.
          </p>
        </motion.div>

        <ProjectGrid />
      </div>
    </main>
  )
}
