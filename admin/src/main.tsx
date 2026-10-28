import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import App from "./App"
import { LanguageProvider } from "./i18n"
import "./styles.css"

// The redesign at /v2/ is where a plain visit lands. Links into a screen here (`/#stats`)
// and `/?classic` from the redesign's own link keep this interface.
const classic = window.location.hash || new URLSearchParams(window.location.search).has("classic")
if (!classic) window.location.replace("/v2/")

const container = document.getElementById("root")
if (!container) throw new Error("#root not found")

if (classic) createRoot(container).render(
  <StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </StrictMode>,
)
