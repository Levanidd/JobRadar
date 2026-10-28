import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { parseArbeitsagentur } from "../../src/adapters/arbeitsagentur"
import { parseArbeitnow } from "../../src/adapters/arbeitnow"
import { parseAshby } from "../../src/adapters/ashby"
import { parseGreenhouse } from "../../src/adapters/greenhouse"
import { parseHimalayas } from "../../src/adapters/himalayas"
import { parseJobicy } from "../../src/adapters/jobicy"
import { parseLever } from "../../src/adapters/lever"
import { parsePersonio, parsePersonioSearch } from "../../src/adapters/personio"
import { parseRecruitee } from "../../src/adapters/recruitee"
import { parseRss } from "../../src/adapters/rss"
import { parseSmartRecruiters } from "../../src/adapters/smartrecruiters"
import { parseTheHub } from "../../src/adapters/thehub"
import { parseWeWorkRemotely } from "../../src/adapters/weworkremotely"
import { parseWorkable } from "../../src/adapters/workable"
import { parseAdzuna } from "../../src/adapters/adzuna"
import { amazonCategorySlug, amazonToken, parseAmazon } from "../../src/adapters/amazon"
import { readWorkdayDescription, workdayDetailUrl } from "../../src/adapters/workday"
import { parseRemote, readRemoteDescription, remoteDetailUrl } from "../../src/adapters/remote"
import { parseZalandoPage, readZalandoDescription, zalandoDetailUrl } from "../../src/adapters/zalando"
import { bodyComesLater } from "../../src/adapters/details"
import { getroBoard } from "../../src/adapters/getro"
import { ibmFilters } from "../../src/adapters/ibm"
import { startupJobsToken } from "../../src/adapters/startup-jobs"
import { telegramChannel } from "../../src/adapters/telegram-channel"
import { detectToken } from "../../src/adapters"
import { matchMarkers } from "../../src/detect"
import { labelFromUrl } from "../../src/adapters/career-ops"
import { dedupKey } from "../../src/company-key"
import { toIso } from "../../src/http"

function load(name: string) {
  return readFileSync(join(import.meta.dirname, "..", "fixtures", name), "utf8")
}

describe("adapter parsers", () => {
  it("parses arbeitsagentur v6 search", () => {
    const jobs = parseArbeitsagentur(JSON.parse(load("arbeitsagentur.json")))
    expect(jobs.length).toBe(2)
    expect(jobs[0]?.externalId).toBe("13635-a49ab6d4_JB5255603-S")
    expect(jobs[0]?.title).toBe("Product Manager Security (m/w/d)")
    expect(jobs[0]?.company).toBe("blackned GmbH")
    expect(jobs[0]?.location).toBe("Berlin")
    expect(jobs[0]?.url).toContain("/jobdetail/13635-a49ab6d4_JB5255603-S")
  })

  it("parses arbeitnow public api", () => {
    const jobs = parseArbeitnow(JSON.parse(load("arbeitnow.json")))
    expect(jobs.length).toBe(3)
    expect(jobs[0]?.company).toContain("GlasfaserPlus")
    expect(jobs[0]?.url).toContain("arbeitnow.com")
  })

  it("parses greenhouse board", () => {
    const jobs = parseGreenhouse(JSON.parse(load("greenhouse.json")))
    expect(jobs[0]?.title).toBe("Acquisition Manager")
    expect(jobs[0]?.url).toContain("airbnb")
  })

  it("parses ashby board", () => {
    const jobs = parseAshby(JSON.parse(load("ashby.json")), "linear")
    expect(jobs[0]?.externalId).toContain("d3bc1ced")
    expect(jobs[0]?.url).toContain("ashbyhq.com")
  })

  it("keeps every Ashby city and the workplace, without splitting the dedup key", () => {
    const title = "Senior Product Manager - Business Banking"
    const [job] = parseAshby({
      jobs: [
        {
          id: "9c3e0b6f-ce76-4bd7-9144-cabce7d5b555",
          title,
          jobUrl: "https://jobs.ashbyhq.com/mollie/9c3e0b6f-ce76-4bd7-9144-cabce7d5b555",
          location: "Milan",
          secondaryLocations: [{ location: "Amsterdam" }, { location: "Berlin" }, { location: "Milan" }],
          workplaceType: "Hybrid",
        },
      ],
    })
    expect(job?.location).toBe("Milan; Amsterdam; Berlin (Hybrid)")
    // The opening is company + title. A longer location must not mint a second job.
    expect(dedupKey("Mollie", title)).toBe("mollie|senior product manager business banking")
    expect(dedupKey("Mollie", title)).not.toContain("berlin")

    const [plain] = parseAshby({
      jobs: [{ id: "1", title: "PM", jobUrl: "https://jobs.ashbyhq.com/acme/1", location: "Berlin" }],
    })
    expect(plain?.location).toBe("Berlin")

    const [remote] = parseAshby({
      jobs: [{ id: "2", title: "PM", jobUrl: "https://jobs.ashbyhq.com/acme/2", isRemote: true }],
    })
    expect(remote?.location).toBe("Remote")
  })

  it("parses lever postings", () => {
    const jobs = parseLever(JSON.parse(load("lever.json")), "palantir")
    expect(jobs[0]?.title).toBe("Administrative Business Partner")
    expect(jobs[0]?.location).toContain("London")
  })

  it("parses smartrecruiters", () => {
    const jobs = parseSmartRecruiters(JSON.parse(load("smartrecruiters.json")))
    expect(jobs[0]?.title).toBe("Senior Information Security Engineer")
    expect(jobs.length).toBe(2)
  })

  it("parses personio xml envelope", () => {
    expect(parsePersonio(load("personio.xml"))).toEqual([])
    const xml = `<?xml version="1.0"?><workzag-jobs><position><id>42</id><name>Product Manager</name><office>Berlin</office><createdAt>2026-01-01</createdAt><jobDescriptions><jobDescription><name>Desc</name><value><![CDATA[<p>Payments</p>]]></value></jobDescription></jobDescriptions></position></workzag-jobs>`
    const jobs = parsePersonio(xml, "acme")
    expect(jobs[0]?.title).toBe("Product Manager")
    expect(jobs[0]?.location).toBe("Berlin")
  })

  it("parses the personio board search feed", () => {
    const jobs = parsePersonioSearch(
      [
        {
          id: 2578538,
          name: "Senior Product Manager",
          seniority: "Experienced",
          keywords: "Payments,B2C",
          description: "",
          office: "Berlin,Remote",
          offices: ["Berlin", "Remote"],
          department: "Product",
        },
        { id: 1, name: "" },
      ],
      "hometogo",
    )
    expect(jobs).toEqual([
      {
        externalId: "2578538",
        title: "Senior Product Manager",
        company: "hometogo",
        location: "Berlin, Remote",
        url: "https://hometogo.jobs.personio.de/job/2578538",
        description: "Product · Experienced · Payments,B2C",
      },
    ])
  })

  it("parses workable widget", () => {
    expect(parseWorkable(JSON.parse(load("workable.json")))).toEqual([])
    const jobs = parseWorkable({
      name: "Doist",
      jobs: [
        {
          title: "Product Manager",
          shortcode: "ABCDE",
          application_url: "https://apply.workable.com/j/ABCDE",
          location: { city: "Berlin", country: "Germany" },
          created_at: "2026-01-01",
          description: "Senior PM",
        },
      ],
    })
    expect(jobs[0]?.externalId).toBe("ABCDE")
  })

  it("parses recruitee offers schema", () => {
    const jobs = parseRecruitee({
      offers: [
        {
          id: 9,
          title: "Product Owner",
          careers_url: "https://acme.recruitee.com/o/po",
          location: { city: "Berlin" },
          published_at: "2026-01-01",
          description: "Fintech",
        },
      ],
    })
    expect(jobs[0]?.url).toContain("recruitee.com")
  })

  it("parses rss feed", () => {
    const jobs = parseRss(load("rss.xml"))
    expect(jobs.length).toBeGreaterThan(0)
    expect(jobs[0]?.url).toContain("weworkremotely.com")
  })

  it("parses adzuna results", () => {
    const jobs = parseAdzuna({
      results: [
        {
          id: "123",
          title: "Product Manager",
          redirect_url: "https://www.adzuna.de/land/ad/123",
          created: "2026-01-01",
          location: { display_name: "Berlin" },
          company: { display_name: "Acme" },
          description: "Senior PM",
        },
      ],
    })
    expect(jobs[0]?.company).toBe("Acme")
  })

  it("parses himalayas feed", () => {
    const jobs = parseHimalayas({
      jobs: [
        {
          title: "Product Lead, AI Email App",
          companyName: "Bjak",
          locationRestrictions: ["China"],
          description: "About the role",
          pubDate: 1787983183,
          guid: "https://himalayas.app/companies/bjak/jobs/product-lead",
          applicationLink: "https://himalayas.app/companies/bjak/jobs/product-lead",
        },
      ],
    })
    expect(jobs[0]?.company).toBe("Bjak")
    expect(jobs[0]?.location).toBe("China")
    expect(jobs[0]?.postedAt?.slice(0, 4)).toBe("2026")
  })

  it("filters himalayas by needle but keeps everything on *", () => {
    const payload = { jobs: [{ title: "Backend Engineer", guid: "https://himalayas.app/x", companyName: "Acme" }] }
    expect(parseHimalayas(payload, "product")).toEqual([])
    expect(parseHimalayas(payload, "*").length).toBe(1)
  })

  it("parses jobicy feed", () => {
    const jobs = parseJobicy({
      jobs: [
        {
          id: 151960,
          url: "https://jobicy.com/jobs/151960-growth-marketing-manager",
          jobTitle: "Growth Marketing Manager",
          companyName: "Keyfactor, Inc.",
          jobGeo: "Canada, USA",
          jobDescription: "<p>About Keyfactor</p>",
          pubDate: "2026-08-28T18:59:52+00:00",
        },
      ],
    })
    expect(jobs[0]?.externalId).toBe("151960")
    expect(jobs[0]?.location).toBe("Canada, USA")
    expect(jobs[0]?.description).toBe("About Keyfactor")
  })

  it("parses thehub docs and merges featured", () => {
    const jobs = parseTheHub({
      jobs: {
        pages: 1,
        docs: [
          {
            id: "6a58cbb9e8c4ea90606db214",
            title: "Head of Germany",
            location: { country: "Germany", locality: "Berlin" },
            company: { name: "Complir" },
          },
        ],
      },
      featuredJobs: {
        docs: [{ id: "feat1", title: "GTM Lead, DACH", isRemote: true, company: { name: "Sumary" } }],
      },
    })
    expect(jobs.length).toBe(2)
    expect(jobs[0]?.url).toBe("https://thehub.io/jobs/6a58cbb9e8c4ea90606db214")
    expect(jobs[0]?.location).toBe("Berlin, Germany")
    expect(jobs[1]?.location).toBe("Remote")
  })

  it("drops feed rows whose link left the board's host", () => {
    const jobs = parseHimalayas({
      jobs: [
        { title: "Product Manager", guid: "http://himalayas.app/insecure", companyName: "A" },
        { title: "Product Manager", guid: "https://evil.example/phish", companyName: "B" },
        { title: "Product Manager", guid: "https://himalayas.app/ok", companyName: "C" },
      ],
    })
    expect(jobs.map((job) => job.company)).toEqual(["C"])
  })

  it("normalises epoch seconds, epoch ms and date strings", () => {
    expect(toIso(1787983183)?.slice(0, 4)).toBe("2026")
    expect(toIso(1787983183000)?.slice(0, 4)).toBe("2026")
    expect(toIso("2026-08-28T18:59:52+00:00")).toBe("2026-08-28T18:59:52.000Z")
    expect(toIso("not a date")).toBeUndefined()
    expect(toIso(null)).toBeUndefined()
  })

  it("splits the company out of a we work remotely title", () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>Acme: Senior Product Manager</title><region>Europe</region>
        <link>https://weworkremotely.com/remote-jobs/acme-spm</link>
        <pubDate>Fri, 28 Aug 2026 10:00:00 +0000</pubDate></item>
      <item><title>Standalone Product Role</title><category>Anywhere</category>
        <link>https://weworkremotely.com/remote-jobs/solo</link></item>
    </channel></rss>`
    const jobs = parseWeWorkRemotely(xml)
    expect(jobs[0]?.company).toBe("Acme")
    expect(jobs[0]?.title).toBe("Senior Product Manager")
    expect(jobs[0]?.location).toBe("Europe")
    expect(jobs[1]?.company).toBeUndefined()
    expect(jobs[1]?.title).toBe("Standalone Product Role")
  })

  it("matches one opening across the boards that carry it", () => {
    const direct = dedupKey("Parloa GmbH", "Senior Product Manager (m/w/d)")
    expect(dedupKey("Parloa", "Senior  Product   Manager")).toBe(direct)
    expect(dedupKey("parloa", "Senior Product Manager (f/m/x)")).toBe(direct)
    // Seniority is a real difference, not a spelling of the same role.
    expect(dedupKey("Parloa", "Junior Product Manager")).not.toBe(direct)
    expect(dedupKey("Parloa", "Senior Product Manager (m/w/d) – Berlin")).toBe(direct)
    expect(dedupKey("Parloa", "Sr. Product Manager")).toBe(direct)
    expect(dedupKey("Parloa", "Product Manager - Growth")).not.toBe(direct)
    expect(dedupKey("", "Product Manager")).toBe("")
  })

  it("names a single-company board from its URL", () => {
    // These boards are one company, so the payload never repeats its name and
    // the vendored providers read it off the config entry instead.
    expect(labelFromUrl("https://join.com/companies/acme/jobs")).toBe("acme")
    expect(labelFromUrl("https://acme.teamtailor.com")).toBe("acme")
    expect(labelFromUrl("https://careers.acme.softgarden.io/de/widgets/jobs")).toBe("acme")
    expect(labelFromUrl("https://www.acme.com/jobs")).toBe("acme")
    expect(labelFromUrl("not a url")).toBe("not a url")
  })

  it("detects ATS tokens from URLs", () => {
    expect(detectToken(new URL("https://boards.greenhouse.io/airbnb"))).toEqual({
      provider: "greenhouse",
      token: "airbnb",
    })
    expect(detectToken(new URL("https://job-boards.eu.greenhouse.io/raisin/jobs/4945588101"))?.token).toBe("raisin")
    expect(detectToken(new URL("https://boards.eu.greenhouse.io/embed/job_board?for=lucanetgroup"))?.token).toBe(
      "lucanetgroup",
    )
    expect(detectToken(new URL("https://jobs.lever.co/palantir/abc"))).toEqual({
      provider: "lever",
      token: "palantir",
    })
    expect(detectToken(new URL("https://jobs.ashbyhq.com/linear"))).toEqual({
      provider: "ashby",
      token: "linear",
    })
    expect(detectToken(new URL("https://jobs.ashbyhq.com/taxfix.com/form/talent-pool"))).toEqual({
      provider: "ashby",
      token: "taxfix.com",
    })
    expect(detectToken(new URL("https://acme.jobs.personio.de/job/1"))).toEqual({
      provider: "personio",
      token: "acme",
    })
    expect(detectToken(new URL("https://acme.breezy.hr"))).toEqual({
      provider: "breezy",
      token: "https://acme.breezy.hr/",
    })
    expect(detectToken(new URL("https://acme.pinpointhq.com"))).toEqual({
      provider: "pinpoint",
      token: "https://acme.pinpointhq.com/",
    })
    expect(detectToken(new URL("https://ats.rippling.com/acme/jobs"))).toEqual({
      provider: "rippling",
      token: "https://ats.rippling.com/acme/jobs",
    })
  })

  it("reads greenhouse pay ranges as yearly salary", () => {
    const jobs = parseGreenhouse({
      jobs: [
        {
          id: 1,
          title: "Product Manager",
          absolute_url: "https://boards.greenhouse.io/x/jobs/1",
          location: { name: "Berlin" },
          pay_input_ranges: [{ min_cents: 8_000_000, max_cents: 11_000_000, currency_type: "EUR" }],
        },
      ],
    })
    expect(jobs[0]?.salary).toEqual({ min: 80_000, max: 110_000, currency: "EUR" })
  })
})

describe("amazon jobs", () => {
  const page = new URL(
    "https://www.amazon.jobs/content/en/locations/germany/berlin?region%5B%5D=Berlin&category%5B%5D=Project%2FProgram%2FProduct+Management--Non-Tech",
  )

  it("turns the Berlin product page into the search filters", () => {
    expect(amazonCategorySlug("Project/Program/Product Management--Non-Tech")).toBe(
      "project-program-product-management-non-tech",
    )
    expect(amazonToken(page)).toBe(
      "normalized_country_code%5B%5D=DEU&normalized_city_name%5B%5D=Berlin&category%5B%5D=project-program-product-management-non-tech",
    )
    expect(detectToken(page)).toEqual({
      provider: "amazon",
      token: amazonToken(page),
    })
  })

  it("reads a search.json posting, including the qualifications", () => {
    const jobs = parseAmazon({
      hits: 1,
      jobs: [
        {
          id_icims: "10526434",
          title: "Security Assurance Specialist",
          company_name: "AWS EMEA SARL (Germany Branch)",
          normalized_location: "Berlin, Berlin, DEU",
          job_path: "/en/jobs/10526434/security-assurance-specialist",
          posted_date: "September 2, 2026",
          description: "<p>Own the control set.</p>",
          basic_qualifications: "English C1",
          preferred_qualifications: "AWS experience",
        },
      ],
    })
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      externalId: "10526434",
      company: "AWS EMEA SARL (Germany Branch)",
      location: "Berlin, Berlin, DEU",
      url: "https://www.amazon.jobs/en/jobs/10526434/security-assurance-specialist",
    })
    expect(jobs[0]?.description).toContain("Own the control set.")
    expect(jobs[0]?.description).toContain("English C1")
    expect(jobs[0]?.description).toContain("AWS experience")
    expect(jobs[0]?.postedAt?.slice(0, 10)).toBe("2026-09-02")
  })
})

describe("new career-ops boards", () => {
  it("recognises the boards their host gives away", () => {
    expect(
      detectToken(new URL("https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/jobs")),
    ).toMatchObject({ provider: "oraclecloud" })
    expect(detectToken(new URL("https://careers-acme.icims.com/jobs/search?ss=1"))).toMatchObject({
      provider: "icims",
    })
    expect(detectToken(new URL("https://acme.applytojob.com/apply"))).toMatchObject({ provider: "jazzhr" })
    expect(detectToken(new URL("https://acme.taleo.net/careersection/2/jobsearch.ftl"))).toMatchObject({
      provider: "taleo",
    })
    expect(
      detectToken(new URL("https://recruiting.ultipro.com/ACM1000/JobBoard/board-id/OpportunityList")),
    ).toMatchObject({ provider: "ultipro" })
    expect(detectToken(new URL("https://career5.successfactors.eu/career?company=acme"))).toMatchObject({
      provider: "successfactors",
    })
    expect(detectToken(new URL("https://jobs.jobvite.com/acme"))).toMatchObject({ provider: "jobvite" })
  })

  it("recognises the corporate and German employer boards", () => {
    const cases: [string, string][] = [
      ["https://bloomberg.avature.net/careers/SearchJobs", "avature"],
      ["https://career-ohb.csod.com/ux/ats/careersite/4/home?c=career-ohb", "csod"],
      ["https://www.comeet.co/careers-api/2.0/company/30.005/positions?token=ABC123", "comeet"],
      [
        "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=abc&ccId=19000101_000001",
        "adp-workforcenow",
      ],
      ["https://db.jobs", "deutschebahn"],
      ["https://www.rheinmetall.com/en/career/vacancies", "rheinmetall"],
      ["https://www.heckler-koch.com/de/Karriere/Stellenangebote", "hecklerkoch"],
      ["https://jobs.tkmsgroup.com/en", "tkms"],
      ["https://www.3ds.com/careers/jobs", "dassault"],
      ["https://www.ibm.com/careers/search?field_keyword_05[0]=Germany", "ibm"],
    ]
    for (const [url, provider] of cases) {
      expect(detectToken(new URL(url)), url).toMatchObject({ provider })
    }
    expect(detectToken(new URL("https://careers.munichre.com/en/search-jobs"))?.provider).not.toBe("radancy")
  })

  it("prefers the hosting platform over the boards a page links to", () => {
    const fund = `<script src="https://cdn.getro.com/assets/app.js"></script>
      <a href="https://job-boards.greenhouse.io/portfolioco/jobs/1">Engineer</a>`
    expect(matchMarkers(fund, "https://jobs.pointnine.com/jobs")).toEqual({
      provider: "getro",
      token: "https://jobs.pointnine.com/jobs",
    })
    const group = `<link href="//cdn.radancy.eu/company/3167/css/site.css">
      <a href="https://boards.greenhouse.io/subsidiary">Subsidiary</a>`
    expect(matchMarkers(group, "https://careers.munichre.com/en/search-jobs")?.provider).toBe("radancy")
    expect(matchMarkers(`<a href="https://jobs.lever.co/acme">Jobs</a>`, "https://acme.com")).toEqual({
      provider: "lever",
      token: "acme",
    })
    expect(
      matchMarkers(
        `<a href="https://jobs.ashbyhq.com/taxfix.com/form/talent-pool-careers-page">Talent pool</a>`,
        "https://taxfix.de/en/job-openings/",
      ),
    ).toEqual({ provider: "ashby", token: "taxfix.com" })
  })

  it("reads a branded SuccessFactors board off the runtime script", () => {
    const page = `<script src="https://performancemanager5.successfactors.eu/verp/vmod_v1/ui/extlib/jquery_3.5.1/jquery.js"></script>`
    expect(matchMarkers(page, "https://jobs.dkb.de/search/?q=&searchResultView=LIST")).toEqual({
      provider: "successfactors",
      token: "https://jobs.dkb.de",
    })
    expect(matchMarkers(page, "https://careers.nemetschek.com/Bluebeam/search/")).toEqual({
      provider: "successfactors",
      token: "https://careers.nemetschek.com/Bluebeam",
    })
    expect(
      matchMarkers(`<script src="https://rmk-map-12.jobs2web.com/map.js"></script>`, "https://jobs.example.com/go/All-Jobs/9170201/"),
    ).toEqual({ provider: "successfactors", token: "https://jobs.example.com" })
  })

  it("reads a branded Avature board off the portal runtime", () => {
    const page = `<script src="/ASSET/portal/jquery/jquerycore/3.7.1/jquery.min.js"></script>`
    expect(matchMarkers(page, "https://careers.unicredit.eu/en_GB/jobsuche")).toEqual({
      provider: "avature",
      token: "https://careers.unicredit.eu/en_GB/jobsuche/SearchJobs",
    })
    expect(
      matchMarkers(page, "https://careers.unicredit.eu/en_GB/jobsuche/SearchJobs/?jobOffset=15"),
    ).toEqual({
      provider: "avature",
      token: "https://careers.unicredit.eu/en_GB/jobsuche/SearchJobs",
    })
  })

  it("reads a Milch & Zucker board off its client script", () => {
    const page = `<script src="/script/gjb_scripts.js"></script>`
    expect(
      matchMarkers(
        page,
        "https://jobs.commerzbank.com/index.php?ac=search_result&search_criterion_channel[]=12&language=2",
      ),
    ).toEqual({ provider: "gjb", token: "https://jobs.commerzbank.com" })
  })

  it("reads an EU-hosted Greenhouse embed off a company page", () => {
    const page = `<script src="https://boards.eu.greenhouse.io/embed/job_board/js?for=lucanetgroup"></script>`
    expect(matchMarkers(page, "https://www.lucanet.com/en/careers/jobs/")).toEqual({
      provider: "greenhouse",
      token: "lucanetgroup",
    })
  })

  it("reads the Workday board off a branded page that links each posting to it", () => {
    const page = `<a href="https://intactfc.wd3.myworkdayjobs.com/intactfc/job/Toronto-Ontario-CAN/Manager_R155977/apply">Apply</a>`
    expect(matchMarkers(page, "https://careers.intactfc.com/jobs")).toEqual({
      provider: "workday",
      token: "https://intactfc.wd3.myworkdayjobs.com/intactfc",
    })
    const localized = `<a href="https://acme.wd5.myworkdayjobs.com/en-US/External/job/Berlin/Dev_R1">Dev</a>`
    expect(matchMarkers(localized, "https://acme.com/careers")?.token).toBe("https://acme.wd5.myworkdayjobs.com/External")
  })

  it("splits a getro board link into the board and its search phrase", () => {
    expect(getroBoard("https://jobs.pointnine.com/jobs?q=product+manager")).toEqual({
      board: "https://jobs.pointnine.com/jobs",
      query: "product manager",
    })
    expect(getroBoard("https://hv.getro.com/jobs")).toEqual({ board: "https://hv.getro.com/jobs", query: "" })
  })

  it("reads IBM facets off a search URL", () => {
    expect(
      ibmFilters(
        "https://www.ibm.com/careers/search?field_keyword_08[0]=Product%20Management&field_keyword_05[0]=Germany",
      ),
    ).toEqual({ country: "Germany", categories: ["Product Management"] })
    expect(ibmFilters("https://www.ibm.com/careers/search")).toEqual({ country: "Germany", categories: [] })
  })

  it("turns aggregator URLs into their query", () => {
    expect(detectToken(new URL("https://startup.jobs/roles/product-manager/remote"))).toEqual({
      provider: "startup-jobs",
      token: "role=product-manager&workplace=remote",
    })
    expect(startupJobsToken(new URL("https://startup.jobs/"))).toBe("*")
    expect(detectToken(new URL("https://speedrun-talent-network.com/?q=product+manager"))).toEqual({
      provider: "a16z-speedrun-talent",
      token: "product manager",
    })
    expect(detectToken(new URL("https://generalist.world/jobs/"))).toEqual({
      provider: "generalist-world",
      token: "*",
    })
    expect(detectToken(new URL("https://news.ycombinator.com/item?id=1&q=berlin"))).toEqual({
      provider: "hackernews",
      token: "berlin",
    })
    expect(telegramChannel(new URL("https://t.me/s/forproducts"))).toBe("forproducts")
    expect(telegramChannel(new URL("https://t.me/forproducts"))).toBe("forproducts")
    expect(telegramChannel(new URL("https://t.me/+AbCdEf123"))).toBeNull()
    expect(telegramChannel(new URL("https://t.me/joinchat/xyz"))).toBeNull()
  })
})

describe("workday descriptions", () => {
  it("builds the detail URL from a posting link and reads the body", () => {
    expect(
      workdayDetailUrl(
        "https://db.wd3.myworkdayjobs.com/DBWebsite/job/London-10-Upper-Bank-Street/Business-Functional-Analyst_R0438608-1",
      ),
    ).toBe(
      "https://db.wd3.myworkdayjobs.com/wday/cxs/db/DBWebsite/job/London-10-Upper-Bank-Street/Business-Functional-Analyst_R0438608-1",
    )
    expect(workdayDetailUrl("https://db.wd3.myworkdayjobs.com/en-US/DBWebsite/job/Berlin/Role_R1")).toBe(
      "https://db.wd3.myworkdayjobs.com/wday/cxs/db/DBWebsite/job/Berlin/Role_R1",
    )
    expect(workdayDetailUrl("https://boards.greenhouse.io/acme/jobs/1")).toBeNull()
    expect(
      readWorkdayDescription({
        jobPostingInfo: { jobDescription: "<p><b>Job Title</b> Analyst</p><p>Build the ledger.</p>" },
      }),
    ).toBe("Job Title Analyst Build the ledger.")
  })
})

/** A page the way Next.js ships it: the data split over `self.__next_f.push` string chunks. */
function flightPage(...chunks: string[]): string {
  const scripts = chunks.map((chunk) => `<script>self.__next_f.push([1,${JSON.stringify(chunk)}])</script>`)
  return `<html><head><meta name="description" content="Zalando Career Website"/></head><body>${scripts.join("")}</body></html>`
}

describe("zalando", () => {
  it("reads postings from the list page, split across chunks", () => {
    const data = JSON.stringify({
      data: [
        {
          title: "Senior Principal Product Manager - Search {Berlin}",
          id: "2724971",
          entity: "Zalando SE",
          offices: ["Berlin", "Dublin"],
          experience_level: "Leadership",
          updated_at: "2026-10-06T00:44:06.199-07:00",
        },
        { title: "", id: "1" },
      ],
      total: 167,
      next: "/search?q=&filters=%7B%7D&limit=15&offset=15",
    })
    const html = flightPage(`1:["$","p",null,{"children":"7 Jobs"}]\n29:${data.slice(0, 40)}`, `${data.slice(40)}\n`)
    expect(parseZalandoPage(html)).toEqual({
      total: 167,
      jobs: [
        {
          externalId: "2724971",
          title: "Senior Principal Product Manager - Search {Berlin}",
          company: "Zalando",
          location: "Berlin, Dublin",
          url: "https://jobs.zalando.com/en/jobs/2724971",
          postedAt: "2026-10-06T00:44:06.199-07:00",
        },
      ],
    })
    expect(parseZalandoPage(flightPage('5:{"data":[],"total":167}'))).toEqual({ jobs: [], total: 167 })
  })

  it("follows the text reference to the posting body", () => {
    const body = "<h1><b>THE ROLE</b></h1><p>Own search ranking — für alle.</p>"
    const length = new TextEncoder().encode(body).length.toString(16)
    const html = flightPage(
      `9:{"content":"$31","rawData":{"Company":"Zalando SE","Job_Description":"$32"}}\n131:T5,other\n`,
      `32:T${length},`,
      `${body}33:["$","div",null,{}]\n`,
    )
    expect(readZalandoDescription(html)).toBe("THE ROLE Own search ranking — für alle.")
    expect(readZalandoDescription(flightPage('9:{"Job_Description":"Inline text"}'))).toBe("Inline text")
    expect(readZalandoDescription(flightPage("9:{}"))).toBeUndefined()
  })

  it("recognises the career site and posting links", () => {
    expect(detectToken(new URL("https://jobs.zalando.com/de/jobs?location=Berlin&level=Leadership"))).toEqual({
      provider: "zalando",
      token: "zalando",
    })
    expect(zalandoDetailUrl("https://jobs.zalando.com/de/jobs/2724849-Principal-Product-Manager")).toBe(
      "https://jobs.zalando.com/en/jobs/2724849",
    )
    expect(zalandoDetailUrl("https://jobs.zalando.com/en/jobs")).toBeNull()
    expect(bodyComesLater("https://jobs.zalando.com/en/jobs/2724849")).toBe(true)
    expect(bodyComesLater("https://boards.greenhouse.io/acme/jobs/1")).toBe(false)
  })
})

describe("remote", () => {
  const id = "9178a8fb-451f-4dde-a040-074d8d139201"

  it("keeps open roles and the first pay band", () => {
    const jobs = parseRemote({
      jobs: [
        {
          status: "open",
          accepting_applications: true,
          public_id: id,
          title: "Associate Account Manager",
          location: "NORAM",
          description: ".",
          opened_at: "2026-10-28T15:28:08Z",
          pay: { rows: [{ min: 128750, max: 144850, currency: "USD" }] },
        },
        { status: "closed", accepting_applications: true, public_id: "closed", title: "Old role" },
        { status: "open", accepting_applications: false, public_id: "paused", title: "Paused role" },
      ],
    })
    expect(jobs).toEqual([
      {
        externalId: id,
        title: "Associate Account Manager",
        company: "Remote",
        location: "NORAM",
        url: `https://apply.remote.com/jobs/${id}`,
        postedAt: "2026-10-28T15:28:08.000Z",
        salary: { min: 128750, max: 144850, currency: "USD" },
      },
    ])
  })

  it("reads the advert and skips the company boilerplate", () => {
    const text = readRemoteDescription({
      job: {
        advert_sections: [
          { heading: "About Remote", doc: { type: "paragraph", content: [{ text: "We hire globally." }] } },
          {
            heading: "Job Description",
            doc: {
              type: "doc",
              content: [
                { type: "heading", content: [{ text: "Key responsibilities" }] },
                { type: "bulleted", content: [{ text: "Own payroll outcomes." }] },
              ],
            },
          },
          { key: "conclusion", heading: "Conclusion", doc: { content: [{ text: "Apply now." }] } },
        ],
      },
    })
    expect(text).toBe("Job Description Key responsibilities - Own payroll outcomes.")
    expect(remoteDetailUrl(`https://apply.remote.com/jobs/${id}`)).toBe(
      `https://apply.remote.com/api/public/jobs/${id}`,
    )
    expect(remoteDetailUrl("https://apply.remote.com/")).toBeNull()
    expect(bodyComesLater(`https://apply.remote.com/jobs/${id}`)).toBe(true)
    expect(detectToken(new URL("https://apply.remote.com/"))).toEqual({ provider: "remote", token: "remote" })
    expect(detectToken(new URL("https://remote.com/openings"))).toEqual({ provider: "remote", token: "remote" })
  })
})
