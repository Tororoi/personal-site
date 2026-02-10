import { motion } from 'motion/react'
import styles from './Footer.module.css'
import { FaLinkedinIn, FaGithub, FaCodepen, FaMedium } from 'react-icons/fa'

export function Footer() {
  const currentYear = new Date().getFullYear()

  const socialLinks = [
    {
      name: 'LinkedIn',
      url: 'https://www.linkedin.com/in/thomas-cantwell/',
      icon: FaLinkedinIn,
    },
    {
      name: 'GitHub',
      url: 'https://github.com/Tororoi',
      icon: FaGithub,
    },
    {
      name: 'Codepen',
      url: 'https://codepen.io/tororoi',
      icon: FaCodepen,
    },
    {
      name: 'Medium',
      url: 'https://cantwell-tom.medium.com/',
      icon: FaMedium,
    },
  ]

  return (
    <footer className={styles.footer}>
      <div className="container">
        <div className={styles.content}>
          <motion.div
            className={styles.socialLinks}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
          >
            {socialLinks.map((link, index) => {
              const Icon = link.icon
              return (
                <motion.a
                  key={link.name}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.socialLink}
                  initial={{ opacity: 0, scale: 0 }}
                  whileInView={{ opacity: 1, scale: 1 }}
                  viewport={{ once: true }}
                  transition={{ delay: index * 0.1, duration: 0.3 }}
                  whileHover={{ scale: 1.1, y: -3 }}
                  whileTap={{ scale: 0.95 }}
                  aria-label={link.name}
                >
                  <Icon />
                  <span className={styles.tooltip}>{link.name}</span>
                </motion.a>
              )
            })}
          </motion.div>

          <motion.p
            className={styles.copyright}
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ delay: 0.4, duration: 0.5 }}
          >
            © {currentYear} Thomas Cantwell. All rights reserved.
          </motion.p>
        </div>
      </div>
    </footer>
  )
}
