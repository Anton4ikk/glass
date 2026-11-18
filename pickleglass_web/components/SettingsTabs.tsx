import Link from 'next/link'

const tabs = [
  { id: 'api-key', name: 'API Key', href: '/settings' },
  { id: 'privacy', name: 'Data & Privacy', href: '/settings/privacy' },
] as const

export default function SettingsTabs({ active }: { active: (typeof tabs)[number]['id'] }) {
  return (
    <div className="mb-8">
      <nav className="flex space-x-10">
        {tabs.map((tab) => (
          <Link
            key={tab.id}
            href={tab.href}
            className={`pb-4 px-2 border-b-2 font-medium text-sm transition-colors ${
              tab.id === active
                ? 'border-gray-900 text-gray-900'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            {tab.name}
          </Link>
        ))}
      </nav>
    </div>
  )
}
