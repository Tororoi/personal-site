import { motion } from 'motion/react'
import styles from './About.module.css'

export function About() {
  return (
    <main className={styles.about}>
      <div className="container">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <h1 className={styles.title}>About Me</h1>

          <div className={styles.content}>
            <motion.section
              className={styles.section}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2, duration: 0.6 }}
            >
              <h2>Hello, I'm Thomas Cantwell</h2>
              <p>
                I'm a full-stack developer passionate about creating interactive
                web experiences and creative tools. With expertise in modern
                JavaScript frameworks and a keen eye for design, I build
                applications that are both functional and beautiful.
              </p>
            </motion.section>

            <motion.section
              className={styles.section}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4, duration: 0.6 }}
            >
              <h2>Skills & Technologies</h2>
              <div className={styles.skills}>
                <div className={styles.skillCategory}>
                  <h3>Frontend</h3>
                  <ul>
                    <li>React & TypeScript</li>
                    <li>JavaScript (ES6+)</li>
                    <li>HTML5 & CSS3</li>
                    <li>Redux & State Management</li>
                    <li>Responsive Design</li>
                  </ul>
                </div>
                <div className={styles.skillCategory}>
                  <h3>Backend</h3>
                  <ul>
                    <li>Node.js</li>
                    <li>Ruby on Rails</li>
                    <li>RESTful APIs</li>
                    <li>Database Design</li>
                  </ul>
                </div>
                <div className={styles.skillCategory}>
                  <h3>Tools & Practices</h3>
                  <ul>
                    <li>Git & GitHub</li>
                    <li>Vite & Build Tools</li>
                    <li>Testing & Debugging</li>
                    <li>Agile Development</li>
                  </ul>
                </div>
              </div>
            </motion.section>

            <motion.section
              className={styles.section}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.6, duration: 0.6 }}
            >
              <h2>What I Do</h2>
              <p>
                I specialize in building pixel-perfect, performant web
                applications with a focus on user experience. Whether it's a
                complex interactive tool, a portfolio site, or a full-stack
                application, I bring creativity and technical expertise to every
                project.
              </p>
              <p>
                My work spans from creative coding projects like pixel drawing
                applications to professional portfolio sites and data
                visualization tools. I'm always exploring new technologies and
                pushing the boundaries of what's possible on the web.
              </p>
            </motion.section>
          </div>
        </motion.div>
      </div>
    </main>
  )
}
