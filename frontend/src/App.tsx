import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from '@/components/layout/Layout'
import Home from '@/pages/Home'
import Chat from '@/pages/Chat'
import Search from '@/pages/Search'
import Code from '@/pages/Code'
import Agents from '@/pages/Agents'
import Router from '@/pages/Router'
import Vault from '@/pages/Vault'
import KG from '@/pages/KG'
import Eval from '@/pages/Eval'
import Plugins from '@/pages/Plugins'
import Sessions from '@/pages/Sessions'
import Trends from '@/pages/Trends'
import OCR from '@/pages/OCR'
import Research from '@/pages/Research'
import Knowledge from '@/pages/Knowledge'
import Proxies from '@/pages/Proxies'
import Perf from '@/pages/Perf'
import Settings from '@/pages/Settings'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="chat" element={<Chat />} />
          <Route path="search" element={<Search />} />
          <Route path="code" element={<Code />} />
          <Route path="agents" element={<Agents />} />
          <Route path="router" element={<Router />} />
          <Route path="vault" element={<Vault />} />
          <Route path="kg" element={<KG />} />
          <Route path="sessions" element={<Sessions />} />
          <Route path="eval" element={<Eval />} />
          <Route path="plugins" element={<Plugins />} />
          <Route path="trends" element={<Trends />} />
          <Route path="ocr" element={<OCR />} />
          <Route path="research" element={<Research />} />
          <Route path="knowledge" element={<Knowledge />} />
          <Route path="proxies" element={<Proxies />} />
          <Route path="perf" element={<Perf />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Home />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
