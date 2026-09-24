import { useState } from 'react'

import { Dashboard } from '@/components/dashboard/Dashboard'
import { Onboarding } from '@/components/onboarding/Onboarding'
import type { Surface } from '@/lib/types'

export default function App() {
  const [config, setConfig] = useState<{ target: string; surface: Surface | null } | null>(null)

  if (!config) return <Onboarding onReady={setConfig} />

  return <Dashboard initialTarget={config.target} surface={config.surface} onReset={() => setConfig(null)} />
}
