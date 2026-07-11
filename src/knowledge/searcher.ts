import { logger } from "../utils/logger.js";

export interface CuratedSource {
  name: string
  url: string
  quality: number
  type: "textbook" | "lecture" | "paper" | "encyclopedia" | "course"
}

// Direct known URLs to open educational resources — no search engine needed.
// These are curated, high-quality, freely accessible sources.
const KNOWN_RESOURCES: Record<string, CuratedSource[]> = {
  "linear-algebra": [
    { name: "MIT 18.06 Linear Algebra (Strang)", url: "https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/pages/syllabus/", quality: 1.0, type: "course" },
    { name: "Linear Algebra - OpenStax", url: "https://openstax.org/books/precalculus-2e/pages/find-a-general-solution-to-digitally-enabled-problems", quality: 0.9, type: "textbook" },
    { name: "Linear Algebra - UC Davis", url: "https://www.math.ucdavis.edu/~linear/linear.pdf", quality: 0.85, type: "textbook" },
    { name: "Linear Algebra Done Wrong", url: "https://www.math.brown.edu/streil/papers/LADW/LADW.html", quality: 0.8, type: "textbook" },
    { name: "Linear Algebra - arXiv", url: "https://arxiv.org/search/?query=linear+algebra+textbook&searchtype=all", quality: 0.7, type: "paper" },
  ],
  "advanced-math": [
    { name: "MIT OCW Mathematics", url: "https://ocw.mit.edu/search/?q=mathematics", quality: 0.95, type: "course" },
    { name: "Abstract Algebra - Harvard", url: "https://people.math.harvard.edu/~ctm/home/text/class/harvard/113/07/html/notes/notes.pdf", quality: 0.85, type: "textbook" },
    { name: "Real Analysis - Rice", url: "https://www.ruf.rice.edu/~fjones/real-anal.pdf", quality: 0.85, type: "textbook" },
    { name: "Complex Analysis - Trinity", url: "https://www.math.trinity.edu/~tharbold/complex/complex.pdf", quality: 0.8, type: "textbook" },
    { name: "Differential Geometry - Stanford", url: "https://graphics.stanford.edu/courses/cs468-02-winter/notes/notes.pdf", quality: 0.8, type: "textbook" },
  ],
  probability: [
    { name: "Probability Course - Harvard", url: "https://projects.iq.harvard.edu/stat110", quality: 0.95, type: "course" },
    { name: "Introduction to Probability - Open Textbook", url: "https://open.umn.edu/opentextbooks/textbooks/introduction-to-probability", quality: 0.9, type: "textbook" },
    { name: "Probability - arXiv", url: "https://arxiv.org/search/?query=probability+theory+textbook&searchtype=all", quality: 0.7, type: "paper" },
  ],
  os: [
    { name: "Operating Systems - Open Textbook", url: "https://pages.cs.wisc.edu/~remzi/OSTEP/", quality: 1.0, type: "textbook" },
    { name: "MIT 6.828 OS Engineering", url: "https://pdos.csail.mit.edu/6.828/2024/schedule.html", quality: 0.95, type: "course" },
    { name: "OS - arXiv", url: "https://arxiv.org/search/?query=operating+systems+textbook&searchtype=all", quality: 0.65, type: "paper" },
  ],
  "comp-arch": [
    { name: "Computer Architecture - Open Textbook", url: "https://www.cambridge.org/us/features/online/textbooks/comparch/", quality: 0.9, type: "textbook" },
    { name: "GPU Programming - CUDA", url: "https://docs.nvidia.com/cuda/cuda-c-programming-guide/index.html", quality: 0.9, type: "textbook" },
    { name: "Comp Arch - arXiv", url: "https://arxiv.org/search/?query=computer+architecture+textbook&searchtype=all", quality: 0.65, type: "paper" },
  ],
  networking: [
    { name: "Computer Networks - Open Textbook", url: "https://computers-communication.blogspot.com/p/computer-networks-textbook.html", quality: 0.85, type: "textbook" },
    { name: "Networking - arXiv", url: "https://arxiv.org/search/?query=computer+networks+textbook&searchtype=all", quality: 0.65, type: "paper" },
  ],
  compilers: [
    { name: "Compiler Design - Open Textbook", url: "https://www3.nd.edu/~dthain/compilerbook/", quality: 0.9, type: "textbook" },
    { name: "Compilers - arXiv", url: "https://arxiv.org/search/?query=compiler+design+textbook&searchtype=all", quality: 0.65, type: "paper" },
  ],
  "gpu-programming": [
    { name: "CUDA Programming Guide", url: "https://docs.nvidia.com/cuda/cuda-c-programming-guide/index.html", quality: 0.95, type: "textbook" },
    { name: "GPU Gems - NVIDIA", url: "https://developer.nvidia.com/gpugems/gpugems/contributors", quality: 0.9, type: "textbook" },
    { name: "GPU Programming - arXiv", url: "https://arxiv.org/search/?query=GPU+programming+survey&searchtype=all", quality: 0.7, type: "paper" },
  ],
  "data-structures": [
    { name: "Open Data Structures", url: "https://opendatastructures.org/", quality: 1.0, type: "textbook" },
    { name: "Algorithms - CLRS", url: "https://www.cs.dartmouth.edu/~thc/clrs-4e/", quality: 0.95, type: "textbook" },
    { name: "Algorithms - Open Textbook", url: "https://www.algorist.com/", quality: 0.85, type: "textbook" },
    { name: "DS&A - arXiv", url: "https://arxiv.org/search/?query=data+structures+algorithms+textbook&searchtype=all", quality: 0.65, type: "paper" },
  ],
  ethics: [
    { name: "Stanford Encyclopedia - Ethics", url: "https://plato.stanford.edu/entries/ethics/", quality: 0.95, type: "encyclopedia" },
    { name: "IEP - Ethics", url: "https://iep.utm.edu/category/value/ethics/", quality: 0.9, type: "encyclopedia" },
  ],
  logic: [
    { name: "Stanford Encyclopedia - Logic", url: "https://plato.stanford.edu/entries/logic-classical/", quality: 0.95, type: "encyclopedia" },
    { name: "IEP - Logic", url: "https://iep.utm.edu/category/logical/", quality: 0.9, type: "encyclopedia" },
  ],
  epistemology: [
    { name: "Stanford Encyclopedia - Epistemology", url: "https://plato.stanford.edu/entries/epistemology/", quality: 0.95, type: "encyclopedia" },
    { name: "IEP - Epistemology", url: "https://iep.utm.edu/category/epistemology/", quality: 0.9, type: "encyclopedia" },
  ],
  metaphysics: [
    { name: "Stanford Encyclopedia - Metaphysics", url: "https://plato.stanford.edu/entries/metaphysics/", quality: 0.95, type: "encyclopedia" },
    { name: "IEP - Metaphysics", url: "https://iep.utm.edu/category/metaphysics/", quality: 0.9, type: "encyclopedia" },
  ],
}

export async function searchDomain(
  domain: string,   // ignored — we search by subdomain key
  subdomain: string,
  _maxResults = 10,
): Promise<{ link: string; title: string; snippet: string }[]> {
  const resources = KNOWN_RESOURCES[subdomain]
  if (!resources || resources.length === 0) {
    logger.warn(`[KnowledgeSearcher] No known resources for: ${subdomain}`)
    return []
  }

  logger.info(`[KnowledgeSearcher] Found ${resources.length} curated sources for ${subdomain}`)
  return resources.map((r) => ({
    link: r.url,
    title: r.name,
    snippet: `${r.type} (quality: ${r.quality})`,
  }))
}

export async function searchDictionary(word: string): Promise<{ link: string; title: string; snippet: string }[]> {
  return [{
    link: `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`,
    title: `Wiktionary: ${word}`,
    snippet: "Wiktionary entry",
  }]
}

export function getSubdomainsForDomain(domain: string): string[] {
  if (domain === "mathematics") return ["advanced-math", "probability", "linear-algebra"]
  if (domain === "computer-science") return ["os", "comp-arch", "networking", "compilers", "gpu-programming", "data-structures"]
  if (domain === "philosophy") return ["ethics", "logic", "epistemology", "metaphysics"]
  return Object.keys(KNOWN_RESOURCES)
}
