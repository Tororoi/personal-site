import { motion } from 'motion/react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import styles from './Contact.module.css';

export function Contact() {
  const [formStatus, setFormStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFormStatus('submitting');

    const form = e.currentTarget;
    const formData = new FormData(form);

    try {
      const response = await fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(formData as any).toString(),
      });

      if (response.ok) {
        setFormStatus('success');
        form.reset();
      } else {
        setFormStatus('error');
      }
    } catch (error) {
      setFormStatus('error');
    }
  };

  return (
    <main className={styles.contact}>
      <div className="container">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <h1 className={styles.title}>Get In Touch</h1>
          <p className={styles.description}>
            Have a project in mind or want to collaborate? I'd love to hear from
            you!
          </p>

          <motion.div
            className={styles.formContainer}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.6 }}
          >
            <form
              name="contact"
              method="POST"
              data-netlify="true"
              onSubmit={handleSubmit}
              className={styles.form}
            >
              <input type="hidden" name="form-name" value="contact" />

              <div className={styles.formGroup}>
                <label htmlFor="name" className={styles.label}>
                  Name
                </label>
                <input
                  type="text"
                  id="name"
                  name="name"
                  required
                  className={styles.input}
                  placeholder="Your name"
                  disabled={formStatus === 'submitting'}
                />
              </div>

              <div className={styles.formGroup}>
                <label htmlFor="email" className={styles.label}>
                  Email
                </label>
                <input
                  type="email"
                  id="email"
                  name="email"
                  required
                  className={styles.input}
                  placeholder="your.email@example.com"
                  disabled={formStatus === 'submitting'}
                />
              </div>

              <div className={styles.formGroup}>
                <label htmlFor="message" className={styles.label}>
                  Message
                </label>
                <textarea
                  id="message"
                  name="message"
                  required
                  rows={6}
                  className={styles.textarea}
                  placeholder="Tell me about your project..."
                  disabled={formStatus === 'submitting'}
                />
              </div>

              <button
                type="submit"
                className={styles.submitBtn}
                disabled={formStatus === 'submitting'}
              >
                {formStatus === 'submitting' ? 'Sending...' : 'Send Message'}
              </button>

              {formStatus === 'success' && (
                <motion.p
                  className={styles.successMessage}
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  ✓ Message sent successfully! I'll get back to you soon.
                </motion.p>
              )}

              {formStatus === 'error' && (
                <motion.p
                  className={styles.errorMessage}
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  ✗ Oops! Something went wrong. Please try again.
                </motion.p>
              )}
            </form>
          </motion.div>
        </motion.div>
      </div>
    </main>
  );
}
