/** A job list opened from somewhere else. It is not the filters saved on the Jobs tab. */

export type JobsPreset =
  | { kind: "company"; key: string; name: string }
  | { kind: "source"; id: number; label: string }
  | { kind: "job"; id: string }

export function jobsPresetKey(preset: JobsPreset | null): string {
  if (!preset) return "own"
  if (preset.kind === "company") return `company:${preset.key}`
  if (preset.kind === "source") return `source:${preset.id}`
  return `job:${preset.id}`
}

/** Applied list opened from Today or Stats. `tab` is also written to the saved tab. */
export type AppliedPreset = {
  tab: "" | "applied" | "interview" | "rejected"
  interviewed?: "" | "yes" | "no"
  company?: string
  jobId?: string
}

export function appliedPresetKey(preset: AppliedPreset | null): string {
  if (!preset) return "own"
  return [preset.tab, preset.interviewed ?? "", preset.company ?? "", preset.jobId ?? ""].join("|")
}
