'use client'

import * as React from 'react'

const STYLE_ELEMENT_ID = 'o365-hide-core-emails-tab'

/**
 * Hides the built-in "Emails" tab button on the person detail so our injected O365 "E-maile" tab
 * (compose/reply with attachments) is the single emails entry point. See `O365PersonEmailThreadsTab`
 * for why we cannot override the built-in tab through the framework.
 *
 * The built-in emails tab is the only person-detail tab rendered with a lucide `Mail` icon
 * (`svg.lucide-mail`), so `[role="tablist"] [role="tab"]:has(svg.lucide-mail)` targets it uniquely.
 * Our injected tab carries no icon, so it is unaffected. If a framework upgrade changes that icon the
 * built-in tab simply reappears (graceful — two tabs, never a crash); re-check this selector then.
 *
 * Rendered as a headless widget at `detail:customers.person:header`, so the style is present for the
 * whole person detail and removed when navigating away (scoped, never leaks to other pages).
 */
export default function HideCoreEmailsTabWidget() {
  React.useEffect(() => {
    if (typeof document === 'undefined') return
    if (document.getElementById(STYLE_ELEMENT_ID)) return
    const style = document.createElement('style')
    style.id = STYLE_ELEMENT_ID
    style.textContent =
      '[role="tablist"] [role="tab"]:has(svg.lucide-mail){display:none !important;}'
    document.head.appendChild(style)
    return () => {
      document.getElementById(STYLE_ELEMENT_ID)?.remove()
    }
  }, [])
  return null
}
