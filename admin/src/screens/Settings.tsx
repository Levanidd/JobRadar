import { AutoRunSettings, ModelUsageLog, RunLog } from "./AutoRun"
import { ModelPicker } from "./ModelPicker"
import { ProfilePromptEditor } from "./ProfilePrompt"
import { Users } from "./Users"

function Heading({ children }: { children: string }) {
  return <h2 className="settings-heading">{children}</h2>
}

/** Master-only: everything that is about the system rather than one person's search. */
export function Settings() {
  return (
    <Users
      header={
        <>
          <Heading>AI</Heading>
          <ModelPicker />
          <ProfilePromptEditor />
          <Heading>Автозапуск</Heading>
          <AutoRunSettings />
          <RunLog />
          <ModelUsageLog />
          <Heading>Пользователи</Heading>
        </>
      }
    />
  )
}
