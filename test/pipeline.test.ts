import { describe, expect, it } from "vitest"

import { careerDomain, companyKey, companyMatchKey, companiesRelated, dedupKey, domainsConflict, employerDomain, locationKey, titleKey } from "../src/company-key"
import { recentExactRepost, repostReason, repostStaysVisible, titleMatch, writeFlags } from "../src/repost"
import { appliedConflict, blankPlaceKey, choosePrimary, mergeVerdicts, type Verdict } from "../src/dedup-group"
import { parsePlaces, placesMatch } from "../src/places"
import { isSuspicious } from "../src/ingest"
import { passesPrefilter, sanitizeTags } from "../src/prefilter"
import { sanitizeCompanyBlacklist } from "../src/settings"
import { formatSalary, toSalary } from "../src/salary"
import { localScore } from "../src/scoring"

describe("companyKey", () => {
  it("collapses legal suffixes and punctuation", () => {
    expect(companyKey("Acme GmbH")).toBe("acme")
    expect(companyKey("Beispiel Bank AG")).toBe("beispiel bank")
    expect(companyKey("Foo, Inc.")).toBe("foo")
  })

  it("treats a legal name as the same employer as its short slug", () => {
    expect(companiesRelated("acme", "acme digital")).toBe(true)
    expect(companiesRelated("pammys dieseo", "pammys")).toBe(true)
    expect(companiesRelated("acme digital", "acme labs")).toBe(false)
  })

  it("drops city and gender tags from a role name", () => {
    expect(titleKey("Senior Product Manager (m/w/d) – Berlin")).toBe("senior product manager")
    expect(titleKey("Sr. Product Manager")).toBe("senior product manager")
    expect(titleKey("Product Manager - Growth")).toBe("product manager growth")
  })

  it("keeps a speciality in parentheses and drops only a place", () => {
    expect(titleKey("Senior Product Manager (Payments)")).toBe("senior product manager payments")
    expect(titleKey("Senior Product Manager (ERP)")).toBe("senior product manager erp")
    expect(titleKey("(Senior) Product Manager")).toBe("senior product manager")
    expect(titleKey("Product Manager (maternity cover)")).toBe("product manager maternity cover")
    expect(titleKey("Product Manager (Berlin)")).toBe("product manager")
    expect(titleKey("Senior Product Manager (all genders)")).toBe("senior product manager")
    expect(titleKey("Senior Product Manager, Core (USA/Europe - Remote)")).toBe("senior product manager core")
  })
})

describe("places", () => {
  it("reads a city out of an office name and ignores a stub", () => {
    expect(locationKey("Berlin Tech")).toBe("berlin")
    expect(locationKey("Blacklane London")).toBe("london")
    expect(locationKey("Staffbase GmbH, Chemnitz")).toBe("chemnitz")
    expect(locationKey("Apaleo HQ")).toBe("")
    expect(locationKey("3 Locations")).toBe("")
    expect(locationKey("Berlin, Berlin, Germany; Berlin")).toBe("berlin+germany")
    expect(locationKey("Berlin, Germany; Berlin")).toBe("berlin+germany")
    expect(locationKey("Berlin, DEU")).toBe("berlin+germany")
    expect(locationKey("Berlin, BE, Germany")).toBe("berlin+germany")
    expect(locationKey("München, BY, Germany")).toBe("germany+munich")
    expect(locationKey("Berlin, Germany")).toBe(locationKey("Berlin, BE, Germany"))
    expect(locationKey("UK / Bulgaria / Malta / South Africa / Spain; Remote")).toBe(
      "bulgaria+malta+south africa+spain+uk",
    )
  })

  it("matches on a shared city and refuses a remote country", () => {
    const berlin = parsePlaces("Berlin, Germany")
    const many = parsePlaces("Milan; Madrid; Berlin; Paris")
    const remote = parsePlaces("Remote (Germany)")
    const germany = parsePlaces("Germany")
    expect(placesMatch(many, parsePlaces("Berlin"))).toBe(true)
    expect(placesMatch(berlin, parsePlaces("London, UK"))).toBe(false)
    expect(placesMatch(germany, berlin)).toBe(true)
    expect(placesMatch(germany, many)).toBe(false)
    expect(placesMatch(parsePlaces("Germany"), parsePlaces("Deutschland"))).toBe(true)
    expect(placesMatch(parsePlaces("Germany"), parsePlaces("France"))).toBe(false)
    expect(placesMatch(remote, berlin)).toBe(false)
    expect(placesMatch(parsePlaces("EMEA"), berlin)).toBe(false)
    expect(placesMatch(parsePlaces(""), berlin)).toBe(false)
    expect(placesMatch(parsePlaces(""), parsePlaces("Remote"))).toBe(false)
    expect(placesMatch(parsePlaces("Remote"), parsePlaces("Remote"))).toBe(false)
    expect(placesMatch(parsePlaces(""), parsePlaces(""))).toBe(true)
  })
})

describe("company match key", () => {
  it("drops a site or a holding from the end and keeps company_key strict", () => {
    expect(companyMatchKey("Hospitable.com")).toBe("hospitable")
    expect(companyMatchKey("Hospitable")).toBe(companyMatchKey("Hospitable.com"))
    expect(companyMatchKey("Nelly Solutions")).toBe(companyMatchKey("Nelly"))
    expect(companyMatchKey("Kraken.com")).toBe(companyMatchKey("Kraken"))
    expect(companyKey("Hospitable.com")).not.toBe(companyKey("Hospitable"))
  })

  it("ignores an aggregator url when deciding the career domain", () => {
    expect(employerDomain("startup-jobs", null, "https://startup.jobs/senior-product-manager-core")).toBeNull()
    expect(employerDomain("workable", "https://apply.workable.com/hospitable", "https://apply.workable.com/hospitable/j/1")).toBe(
      "apply.workable.com/hospitable",
    )
    expect(
      domainsConflict(
        employerDomain("workable", null, "https://apply.workable.com/hospitable/j/1"),
        employerDomain("startup-jobs", null, "https://startup.jobs/hospitable"),
      ),
    ).toBe(false)
  })

  it("treats a different career domain as a different employer", () => {
    expect(domainsConflict(careerDomain("https://impact.com/jobs/1"), careerDomain("https://impact.io/jobs/1"))).toBe(true)
    expect(
      domainsConflict(
        careerDomain("https://job-boards.greenhouse.io/hospitable/jobs/1"),
        careerDomain("https://boards.greenhouse.io/hospitable/jobs/2"),
      ),
    ).toBe(false)
  })
})

describe("repost flag", () => {
  it("calls the same role exact and ignores a seniority-only pair", () => {
    expect(titleMatch("Senior Product Owner (m/f/d)", "Senior Product Owner")).toBe("exact")
    expect(titleMatch("Lead Product Manager", "Product Manager")).toBeNull()
    expect(titleMatch("Senior Product Owner", "Product Owner")).toBeNull()
    expect(titleMatch("Staff Product Manager - Internal AI", "Senior Product Manager - Internal AI")).toBe("similar")
    expect(titleMatch("Senior Product Owner", "Account Executive")).toBeNull()
  })

  it("keeps today's relocation in another city visible", () => {
    const flag = {
      repost_of: "berlin",
      prev_status: "applied" as const,
      prev_date: "2026-10-27 14:22:36",
      match: "exact" as const,
    }
    expect(repostStaysVisible(flag, ["relocation_only"], "London, UK", "Berlin, Germany", new Date("2026-10-27T16:00:00Z"))).toBe(true)
    expect(repostStaysVisible(flag, ["relocation_only"], "London, UK", "Berlin, Germany", new Date("2026-10-26T16:00:00Z"))).toBe(false)
    expect(repostReason("rejected", "2026-09-21 14:26:28")).toBe("репост: rejected 2026-09-21")
  })

  it("skips scoring only for an exact repost from the last 60 days", () => {
    const flags = writeFlags(null, {
      repost_of: "old",
      prev_status: "applied",
      prev_date: "2026-10-06 07:18:20",
      match: "exact",
    })
    expect(recentExactRepost(flags, Date.parse("2026-10-27T12:00:00Z"))).toBe(true)
    const old = writeFlags(null, {
      repost_of: "old",
      prev_status: "rejected",
      prev_date: "2026-01-01 00:00:00",
      match: "exact",
    })
    expect(recentExactRepost(old, Date.parse("2026-10-27T12:00:00Z"))).toBe(false)
  })
})

describe("dedup group", () => {
  const verdict = (over: Partial<Verdict>): Verdict => ({
    user_id: 1,
    job_id: "a",
    status: "new",
    score: null,
    score_reason: null,
    flags: null,
    notes: null,
    applied_at: null,
    viewed_at: null,
    later_at: null,
    notified_at: null,
    interviewed_at: null,
    cv_url: null,
    claude_comment: null,
    ...over,
  })

  it("joins a blank place only when the group has one location", () => {
    expect(blankPlaceKey(["berlin+germany"])).toBe("berlin+germany")
    expect(blankPlaceKey(["berlin+germany", "berlin+germany", ""])).toBe("berlin+germany")
    expect(blankPlaceKey(["berlin+germany", "london+uk"])).toBeNull()
    expect(blankPlaceKey(["", ""])).toBeNull()
  })

  it("keeps two applications more than two days apart apart", () => {
    expect(
      appliedConflict([
        verdict({ job_id: "a", applied_at: "2026-10-12 09:00:00" }),
        verdict({ job_id: "b", applied_at: "2026-10-15 09:00:00" }),
      ])?.userId,
    ).toBe(1)
    expect(
      appliedConflict([
        verdict({ job_id: "a", applied_at: "2026-10-12 09:00:00" }),
        verdict({ job_id: "b", applied_at: "2026-10-14 09:00:00" }),
      ]),
    ).toBeNull()
  })

  it("merges the furthest status onto the primary and keeps both comments", () => {
    const merged = mergeVerdicts("ats", [
      verdict({
        job_id: "ats",
        status: "rejected",
        applied_at: "2026-10-12 09:00:00",
        cv_url: "https://cv.example/a",
      }),
      verdict({
        job_id: "board",
        status: "new",
        score: 94,
        score_reason: "strong",
        cv_url: "https://cv.example/a",
        claude_comment: "[auto-review]",
      }),
    ])
    expect(merged).toEqual([
      expect.objectContaining({
        job_id: "ats",
        status: "rejected",
        applied_at: "2026-10-12 09:00:00",
        cv_url: "https://cv.example/a",
        claude_comment: "[auto-review]",
        score: 94,
        score_reason: "strong",
      }),
    ])
  })

  it("picks the applied listing over a fuller career-site copy", () => {
    const primary = choosePrimary(
      [
        { id: "board", location: null, first_seen_at: "2026-10-01 00:00:00", provider: "arbeitnow" },
        { id: "ats", location: "Berlin, Germany", first_seen_at: "2026-10-02 00:00:00", provider: "greenhouse" },
      ],
      [verdict({ job_id: "ats", status: "rejected", applied_at: "2026-10-12 09:00:00" })],
    )
    expect(primary.id).toBe("ats")
  })
})

describe("locationKey", () => {
  it("treats the same city spelled with a country code as one place", () => {
    const berlin = "berlin+germany"
    expect(locationKey("Berlin, Germany; Berlin")).toBe(berlin)
    expect(locationKey("Berlin, Germany")).toBe(berlin)
    expect(locationKey("Berlin, DEU")).toBe(berlin)
  })

  it("keeps different cities apart, including a remote country", () => {
    expect(locationKey("London, UK")).toBe("london+uk")
    expect(locationKey("London, United Kingdom")).toBe("london+uk")
    expect(locationKey("New York, NY")).toBe("new york")
    expect(locationKey("NYC")).toBe("new york")
    expect(locationKey("Remote (Germany)")).toBe("germany")
    expect(locationKey("Berlin, Germany")).not.toBe(locationKey("London, UK"))
    expect(locationKey("Berlin, Germany")).not.toBe(locationKey("New York, NY"))
    expect(locationKey("Remote (Germany)")).not.toBe(locationKey("Berlin, Germany"))
    expect(locationKey("Palo Alto")).toBe("palo alto")
    expect(locationKey("San Francisco, CA")).toBe("san francisco")
    expect(locationKey("München")).toBe("munich")
    expect(locationKey("Remote")).toBe("")
    expect(locationKey("")).toBe("")
  })
})

describe("dedupKey", () => {
  it("includes the place, and omits it only when the place is unknown", () => {
    const role = "Senior Product Manager, Payments"
    expect(dedupKey("Navan", role, "Berlin, Germany")).toBe("navan|senior product manager payments|berlin+germany")
    expect(dedupKey("Navan", role, "London, UK; London")).toBe("navan|senior product manager payments|london+uk")
    expect(dedupKey("Navan", role, "London, United Kingdom")).toBe("navan|senior product manager payments|london+uk")
    expect(dedupKey("Navan", role, "New York, NY")).toBe("navan|senior product manager payments|new york")
    expect(dedupKey("Navan", role)).toBe("navan|senior product manager payments")
    expect(dedupKey("Navan", role, "Berlin, Germany")).not.toBe(dedupKey("Navan", role, "London, UK"))
  })
})

describe("prefilter", () => {
  it("keeps product roles and drops students", () => {
    expect(passesPrefilter("Senior Product Manager")).toBe(true)
    expect(passesPrefilter("Werkstudent Produktmanagement")).toBe(false)
    expect(passesPrefilter("Backend Engineer")).toBe(false)
  })

  it("ignores case and extra whitespace", () => {
    expect(passesPrefilter("  SENIOR   PRODUCT   MANAGER  ")).toBe(true)
    expect(passesPrefilter("Ai  Product Lead", { keep: ["ai product"], drop: [] })).toBe(true)
  })

  it("uses the supplied keep and drop tags", () => {
    const rules = { keep: ["Produktmanager"], drop: ["Werkstudent"] }
    expect(passesPrefilter("Senior Produktmanager", rules)).toBe(true)
    expect(passesPrefilter("Werkstudent Produktmanager", rules)).toBe(false)
    expect(passesPrefilter("Backend Engineer", rules)).toBe(false)
  })

  it("rejects everything when keep is empty", () => {
    expect(passesPrefilter("Senior Product Manager", { keep: [], drop: [] })).toBe(false)
  })

  it("collapses duplicates and extra spaces in tags", () => {
    expect(sanitizeTags(["  Product   Manager  ", "product manager", "", 12])).toEqual(["Product Manager"])
  })
})

describe("company blacklist", () => {
  it("keeps display names and unique keys", () => {
    expect(
      sanitizeCompanyBlacklist([
        { company_key: "Acme", company: "  Acme GmbH  " },
        { company_key: "acme", company: "Acme" },
        { company_key: "", company: "Nope" },
        { company: "Missing key" },
      ]),
    ).toEqual([{ company_key: "acme", company: "Acme GmbH" }])
  })
})

describe("ingest guard", () => {
  it("flags a truncated fetch", () => {
    expect(isSuspicious(100, 40)).toBe(true)
    expect(isSuspicious(100, 80)).toBe(false)
    expect(isSuspicious(null, 0)).toBe(false)
  })
})

describe("salary", () => {
  it("normalises yearly ranges and greenhouse cents", () => {
    expect(toSalary({ min: 80_000, max: 110_000, currency: "eur" })).toEqual({
      min: 80_000,
      max: 110_000,
      currency: "EUR",
    })
    expect(toSalary({ min: 8_000_000, max: 11_000_000, currency: "EUR", cents: true })).toEqual({
      min: 80_000,
      max: 110_000,
      currency: "EUR",
    })
    expect(toSalary({ min: 40, period: "hour", currency: "EUR" })?.min).toBe(83_200)
    expect(formatSalary(80_000, 110_000, "EUR")).toBe("€80k–110k")
    expect(formatSalary(150_000, null, "USD")).toBe("from $150k")
  })
})

describe("local scoring", () => {
  it("zeros junior roles", () => {
    const result = localScore({
      external_id: "1",
      title: "Jr. Product Manager",
      company: "X",
      location: "Köln",
      description: "Junior role",
    })
    expect(result.score).toBe(0)
    expect(result.flags).toContain("not_senior")
  })

  it("does not treat internal or international as an intern role", () => {
    const result = localScore({
      external_id: "1",
      title: "Staff Product Manager",
      company: "Databricks",
      location: "Berlin, Germany",
      description: "Work with internal teams on an international product.",
    })
    expect(result.score).toBeGreaterThan(0)
    expect(result.flags).not.toContain("not_senior")
  })
})
