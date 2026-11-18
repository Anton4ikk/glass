'use client'

import { useState, useEffect } from 'react'
import { checkApiKeyStatus, saveApiKey } from '@/utils/api'
import SettingsTabs from '@/components/SettingsTabs'

export default function SettingsPage() {
  const [hasApiKey, setHasApiKey] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    checkApiKeyStatus()
      .then(status => setHasApiKey(status.hasApiKey))
      .catch(error => console.error('Failed to fetch API key status:', error))
  }, [])

  const handleSaveApiKey = async () => {
    setIsSaving(true)
    try {
      await saveApiKey(apiKeyInput)
      setHasApiKey(true)
      setApiKeyInput('')
    } catch (error) {
      console.error('Failed to save API key:', error)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="bg-stone-50 min-h-screen">
      <div className="px-8 py-8">
        <div className="mb-6">
          <p className="text-xs text-gray-500 mb-1">Settings</p>
          <h1 className="text-3xl font-bold text-gray-900">Settings</h1>
        </div>

        <SettingsTabs active="api-key" />

        <div className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-lg p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-1">API Key</h3>
            <p className="text-sm text-gray-600 mb-4">
              Add your own OpenAI API key here. It is stored locally and used for requests made by the desktop app.
            </p>

            <div className="max-w-sm">
              <label htmlFor="api-key" className="block text-sm font-medium text-gray-700 mb-1">
                API Key
              </label>
              <div className="flex gap-2">
                <input
                  type="password"
                  id="api-key"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  className="flex-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm text-black"
                  placeholder="Enter new API key or existing API key"
                />
              </div>
              {hasApiKey ? (
                <p className="text-xs text-green-600 mt-2">API key is currently set.</p>
              ) : (
                <p className="text-xs text-gray-500 mt-2">No API key set.</p>
              )}
            </div>

            <div className="mt-4 pt-4 border-t border-gray-200 flex justify-end">
              <button
                onClick={handleSaveApiKey}
                disabled={isSaving || !apiKeyInput}
                className="px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-gray-800 hover:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-900 disabled:opacity-50"
              >
                {isSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
