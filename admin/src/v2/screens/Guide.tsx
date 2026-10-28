import { useT } from "../../i18n"
import type { Screen } from "../Sidebar"
import { Icon } from "../ui"

/** Placeholder until the redesigned screen lands: points to the same screen in the current admin. */
export function Guide(_props: { onScreen: (screen: Screen) => void }) {
  const t = useT()
  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">{t("Guide")}</h1>
      </header>
      <p className="muted" style={{ margin: 0 }}>
        {t("This screen is not redesigned yet.")}{" "}
        <a href="/#guide">
          {t("Open it in the current interface")} <Icon name="external" size={13} />
        </a>
      </p>
    </div>
  )
}
