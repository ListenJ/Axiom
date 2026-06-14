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
          <Route path="eval" element={<Eval />} />
          <Route path="plugins" element={<Plugins />} />
          <Route path="perf" element={<Perf />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Home />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
