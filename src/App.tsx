import { Routes, Route, useLocation } from 'react-router-dom'
import { AnimatePresence } from 'motion/react'
import { Header } from './components/layout/Header'
import { Footer } from './components/layout/Footer'
import { Home } from './pages/Home'
import { Projects } from './pages/Projects'
import { Blog } from './pages/Blog'
import { About } from './pages/About'
import { Contact } from './pages/Contact'

function App() {
  const location = useLocation()

  return (
    <div className="app">
      <a href="#main-content" className="skip-to-main">
        Skip to main content
      </a>
      <Header />
      <AnimatePresence mode="wait">
        <Routes location={location} key={location.pathname}>
          <Route path="/" element={<Home />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/blog" element={<Blog />} />
          <Route path="/about" element={<About />} />
          <Route path="/contact" element={<Contact />} />
        </Routes>
      </AnimatePresence>
      <Footer />
    </div>
  )
}

export default App
