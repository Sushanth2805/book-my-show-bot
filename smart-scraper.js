/**
 * BookMyShow Smart Scraper - Universal Movie Monitor
 * Optimized and Refactored Version
 *
 * Automatically detects:
 * - Coming Soon movies: Monitors until booking opens
 * - Released movies: Gets current showtimes immediately
 *
 * Handles URL pattern changes and sends Telegram notifications
 */

require("dotenv").config();
const puppeteer = require("puppeteer");
const axios = require("axios");

// ================================
// CONFIGURATION & CONSTANTS
// ================================

const CONFIG = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  CHECK_INTERVAL_MINUTES: parseInt(process.env.CHECK_INTERVAL_MINUTES) || 60,
  BROWSER_TIMEOUT: 45000,
  RETRY_DELAY: 3000,
  PAGE_VIEWPORT: { width: 1366, height: 768 },
  USER_AGENT:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

const THEATRE_PATTERNS = {
  KEYWORDS: [
    "cinema",
    "multiplex",
    "mall",
    "theatre",
    "pvr",
    "inox",
    "miraj",
    "asian",
    "aparna",
    "amb",
    "gpr",
    "cinemax",
    "cinepolis",
    "carnival",
    // Local/specific theatres
    "vyjayanthi",
    "uk cineplex",
    "uk",
    "cineplex",
    "sandhya",
    "sudarshan",
    "talluri",
    "nacharam",
    "kushaiguda",
    "rtc x roads",
    "35mm",
    "dolby atmos",
    "laser",
    // AMR Planet Mall area
    "amr",
    "planet mall",
    "moula ali",
    "ecil",
    "secunderabad",
  ],
  EXCLUDE_PATTERNS: [
    /movies?\s+in\s+/i,
    /dolby\s+cinema/i,
    /top\s+cinema/i,
    /cinema\s+chain/i,
    /part\s+\d+/i,
    /sword\s+vs\s+spirit/i,
    /hari\s+hara\s+veera/i,
    /^\d+d$/i,
    /connplex|gold\s+cinema$/i,
    /^(pvr|inox|cinepolis|miraj\s+cinemas|asian\s+cinemas)$/i,
  ],
  LOCATIONS: [
    "hyderabad",
    "nacharam",
    "kushaiguda",
    "secunderabad",
    "moula ali",
    "ecil",
  ],
  TIME_REGEX: /\d{1,2}:\d{2}\s*(am|pm|AM|PM)/gi,
};

const HARDCODED_MOVIES = [
  {
    name: "Coolie",
    url: "https://in.bookmyshow.com/movies/hyderabad/coolie/buytickets/ET00395817/20250814",
    emoji: "🚂",
    releaseDate: "August 14, 2025",
  },
  {
    name: "War 2",
    url: "https://in.bookmyshow.com/movies/hyderabad/war-2/buytickets/ET00356501/20250814",
    emoji: "💥",
    releaseDate: "August 14, 2025",
  },
];

const BROWSER_CONFIG = {
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-accelerated-2d-canvas",
    "--no-first-run",
    "--no-zygote",
    "--disable-gpu",
  ],
};

// ================================
// UTILITY FUNCTIONS
// ================================

/**
 * Validates configuration and displays startup info
 */
function validateConfig() {
  if (!CONFIG.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is required in .env file");
  }
  if (!CONFIG.TELEGRAM_CHAT_ID) {
    throw new Error("TELEGRAM_CHAT_ID is required in .env file");
  }

  console.log(`🔧 Configuration loaded:`);
  console.log(
    `⏰ Check interval: ${CONFIG.CHECK_INTERVAL_MINUTES} minutes (${(
      CONFIG.CHECK_INTERVAL_MINUTES / 60
    ).toFixed(2)}h)`
  );
}

/**
 * Creates optimized browser instance
 */
async function createBrowser() {
  const browser = await puppeteer.launch(BROWSER_CONFIG);
  const page = await browser.newPage();

  await page.setUserAgent(CONFIG.USER_AGENT);
  await page.setViewport(CONFIG.PAGE_VIEWPORT);

  return { browser, page };
}

/**
 * Analyzes URL to determine movie status and details
 */
function analyzeURL(url) {
  const movieCodeMatch = url.match(/ET\d+/);
  const dateMatch = url.match(/(\d{8})(?:\D|$)/);

  return {
    originalUrl: url,
    movieCode: movieCodeMatch ? movieCodeMatch[0] : null,
    releaseDate: dateMatch ? dateMatch[1] : null,
    type: url.includes("?type=coming-soon")
      ? "coming-soon"
      : url.includes("/buytickets/") && dateMatch
      ? "released"
      : "unknown",
    movieName: extractMovieName(url),
  };
}

/**
 * Extracts movie name from URL
 */
function extractMovieName(url) {
  const nameMatch = url.match(/\/movies\/[^\/]+\/([^\/]+)\//);
  return nameMatch
    ? nameMatch[1].replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
    : null;
}

/**
 * Enhanced theatre line detection for longer theatre names
 */
function isTheatreLine(line) {
  return (
    (THEATRE_PATTERNS.KEYWORDS.some((keyword) =>
      line.toLowerCase().includes(keyword)
    ) ||
      /\d+(mm|k)\s*(dolby|atmos|laser)/i.test(line) ||
      /(cinema|theatre|theatres)\s*:/i.test(line) ||
      /:\s*(hyderabad|nacharam|kushaiguda|rtc)/i.test(line)) &&
    line.length > 5 &&
    line.length < 200 && // Increased from 100 to 200 for longer theatre names
    !line.includes("http") &&
    !line.includes("Select") &&
    !line.match(/^\d+$/) &&
    !THEATRE_PATTERNS.EXCLUDE_PATTERNS.some((pattern) => pattern.test(line)) &&
    (line.includes(":") ||
      line.includes(",") ||
      line.includes(" - ") || // Additional separator
      THEATRE_PATTERNS.LOCATIONS.some((loc) =>
        line.toLowerCase().includes(loc)
      ) ||
      /\d+(mm|k)/i.test(line) ||
      THEATRE_PATTERNS.TIME_REGEX.test(line)) // Check for inline times
  );
}

/**
 * Enhanced showtime extraction with better range handling
 */
function extractShowtimes(lines, centerIndex, range = 15) {
  const showtimes = [];
  const start = Math.max(0, centerIndex - 5);
  const end = Math.min(centerIndex + range, lines.length);

  // Extract from the specified range
  for (let i = start; i < end; i++) {
    const timeMatches = lines[i].match(THEATRE_PATTERNS.TIME_REGEX);
    if (timeMatches) {
      showtimes.push(...timeMatches);
    }
  }

  // Additional pass: Look for showtimes in the same line as theatre name
  if (centerIndex < lines.length) {
    const currentLine = lines[centerIndex];
    const inlineTimes = currentLine.match(THEATRE_PATTERNS.TIME_REGEX) || [];
    showtimes.push(...inlineTimes);
  }

  // Look for showtimes in the next few lines (common pattern)
  for (
    let i = centerIndex + 1;
    i < Math.min(centerIndex + 8, lines.length);
    i++
  ) {
    const line = lines[i];
    // Skip lines that look like theatre names
    if (line.length > 50 || line.includes("http") || line.includes("Select"))
      continue;

    const timeMatches = line.match(THEATRE_PATTERNS.TIME_REGEX);
    if (timeMatches) {
      showtimes.push(...timeMatches);
    }
  }

  return [...new Set(showtimes)];
}

/**
 * Improves theatre name by finding better context
 */
function improveTheatreName(lines, lineIndex, originalName) {
  const start = Math.max(0, lineIndex - 2);
  const end = Math.min(lineIndex + 3, lines.length);

  for (let i = start; i < end; i++) {
    const contextLine = lines[i].trim();
    if (
      contextLine.length > originalName.length &&
      contextLine.length < 100 &&
      (contextLine.toLowerCase().includes(originalName.toLowerCase()) ||
        originalName.toLowerCase().includes(contextLine.toLowerCase())) &&
      !contextLine.match(/^\d+$/) &&
      !contextLine.includes("http") &&
      (contextLine.includes(":") || contextLine.includes(","))
    ) {
      return contextLine;
    }
  }
  return originalName;
}

// ================================
// CORE SCRAPING FUNCTIONS
// ================================

/**
 * Enhanced theatre and showtime extraction for long lists
 */
function extractTheatresAndShowtimes(bodyText) {
  const lines = bodyText.split("\n").filter((line) => line.trim());
  const theatreMap = new Map();

  // Enhanced theatre detection patterns
  const theatrePatterns = [
    // Specific theatre patterns for Vyjayanthi and UK Cineplex
    /^([^:]*vyjayanthi[^:]*):/i,
    /^([^:]*uk\s*cineplex[^:]*):/i,
    // Direct theatre patterns
    /^([^:]+(?:cinema|multiplex|mall|theatre|pvr|inox|miraj|asian|aparna|amb|gpr|cinemax|cinepolis|carnival)[^:]*):/i,
    // Location-based patterns
    /^([^:]+(?:hyderabad|nacharam|kushaiguda|secunderabad|moula ali|ecil)[^:]*):/i,
    // Generic theatre patterns
    /^([^:]+(?:cinema|theatre|theatres)[^:]*):/i,
    // Time-based patterns (theatre name followed by times)
    /^([^:]+):\s*\d{1,2}:\d{2}\s*(am|pm|AM|PM)/i,
    // Theatre name with dash separator
    /^([^-]+(?:cinema|multiplex|mall|theatre|pvr|inox|miraj|asian|aparna|amb|gpr|cinemax|cinepolis|carnival)[^-]*)-/i,
    // Theatre name with dot separator
    /^([^.]+(?:cinema|multiplex|mall|theatre|pvr|inox|miraj|asian|aparna|amb|gpr|cinemax|cinepolis|carnival)[^.]*)\./i,
    // Theatre name with parentheses
    /^([^(]+(?:cinema|multiplex|mall|theatre|pvr|inox|miraj|asian|aparna|amb|gpr|cinemax|cinepolis|carnival)[^(]*)/i,
  ];

  // First pass: Find all potential theatre lines
  const theatreCandidates = [];

  lines.forEach((line, index) => {
    const trimmedLine = line.trim();

    // Check if line matches any theatre pattern
    let isTheatre = false;
    let theatreName = null;

    for (const pattern of theatrePatterns) {
      const match = trimmedLine.match(pattern);
      if (match) {
        isTheatre = true;
        theatreName = match[1].trim();
        break;
      }
    }

    // Also check the original criteria for backward compatibility
    if (!isTheatre && isTheatreLine(trimmedLine)) {
      isTheatre = true;
      theatreName = trimmedLine;
    }

    if (isTheatre && theatreName) {
      theatreCandidates.push({
        index,
        name: theatreName,
        originalLine: trimmedLine,
      });
    }
  });

  // Second pass: Extract showtimes for each theatre with expanded range
  theatreCandidates.forEach((candidate) => {
    const { index, name, originalLine } = candidate;

    // Expanded showtime extraction range (15 lines instead of 8)
    const showtimes = extractShowtimes(lines, index, 15);

    // Additional showtime extraction from the same line
    const inlineTimes = originalLine.match(THEATRE_PATTERNS.TIME_REGEX) || [];
    showtimes.push(...inlineTimes);

    if (showtimes.length > 0) {
      // Improve theatre name with better context
      const improvedName = improveTheatreName(lines, index, name);

      // More flexible normalization
      const normalizedKey = improvedName
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();

      // Handle duplicates more intelligently
      if (!theatreMap.has(normalizedKey)) {
        theatreMap.set(normalizedKey, {
          theatre: improvedName,
          showtimes: [...new Set(showtimes)],
        });
      } else {
        const existing = theatreMap.get(normalizedKey);
        const allShowtimes = [
          ...new Set([...existing.showtimes, ...showtimes]),
        ];
        existing.showtimes = allShowtimes;

        // Keep the better theatre name (longer/more descriptive)
        if (improvedName.length > existing.theatre.length) {
          existing.theatre = improvedName;
        }
      }
    }
  });

  // Third pass: Look for additional theatres that might have been missed
  // This handles cases where theatres are listed without clear patterns
  lines.forEach((line, index) => {
    const trimmedLine = line.trim();

    // Skip if already processed
    if (theatreCandidates.some((c) => c.index === index)) return;

    // Look for lines that contain theatre keywords but weren't caught
    const hasTheatreKeyword = THEATRE_PATTERNS.KEYWORDS.some((keyword) =>
      trimmedLine.toLowerCase().includes(keyword)
    );

    const hasTime = THEATRE_PATTERNS.TIME_REGEX.test(trimmedLine);

    if (
      hasTheatreKeyword &&
      hasTime &&
      trimmedLine.length > 10 &&
      trimmedLine.length < 150
    ) {
      // Extract theatre name (everything before the first time)
      const timeMatch = trimmedLine.match(THEATRE_PATTERNS.TIME_REGEX);
      if (timeMatch) {
        const timeIndex = trimmedLine.indexOf(timeMatch[0]);
        const theatreName = trimmedLine.substring(0, timeIndex).trim();

        if (theatreName.length > 3) {
          const showtimes =
            trimmedLine.match(THEATRE_PATTERNS.TIME_REGEX) || [];
          const normalizedKey = theatreName
            .toLowerCase()
            .replace(/[^\w\s]/g, "")
            .replace(/\s+/g, " ")
            .trim();

          if (!theatreMap.has(normalizedKey)) {
            theatreMap.set(normalizedKey, {
              theatre: theatreName,
              showtimes: [...new Set(showtimes)],
            });
          }
        }
      }
    }
  });

  return Array.from(theatreMap.values());
}

/**
 * Alternative theatre extraction method for missed theatres
 */
function extractTheatresAlternative(bodyText) {
  const lines = bodyText.split("\n").filter((line) => line.trim());
  const theatreMap = new Map();

  // Specific theatres to look for
  const specificTheatres = ["vyjayanthi", "uk cineplex", "uk", "cineplex"];

  // Look for lines that contain both theatre keywords and times
  lines.forEach((line, index) => {
    const trimmedLine = line.trim();

    // Skip very short or very long lines
    if (trimmedLine.length < 8 || trimmedLine.length > 300) return;

    // Check if line contains theatre keywords
    const hasTheatreKeyword = THEATRE_PATTERNS.KEYWORDS.some((keyword) =>
      trimmedLine.toLowerCase().includes(keyword)
    );

    // Check if line contains specific theatres we want
    const hasSpecificTheatre = specificTheatres.some((theatre) =>
      trimmedLine.toLowerCase().includes(theatre)
    );

    // Check if line contains times
    const times = trimmedLine.match(THEATRE_PATTERNS.TIME_REGEX) || [];

    if ((hasTheatreKeyword || hasSpecificTheatre) && times.length > 0) {
      // Try to extract theatre name by finding the part before the first time
      const firstTime = times[0];
      const timeIndex = trimmedLine.indexOf(firstTime);

      if (timeIndex > 0) {
        let theatreName = trimmedLine.substring(0, timeIndex).trim();

        // Clean up theatre name
        theatreName = theatreName
          .replace(/^[^a-zA-Z]*/, "")
          .replace(/[^a-zA-Z0-9\s\-\.\(\)]*$/, "");

        if (theatreName.length > 3 && theatreName.length < 100) {
          const normalizedKey = theatreName
            .toLowerCase()
            .replace(/[^\w\s]/g, "")
            .replace(/\s+/g, " ")
            .trim();

          if (!theatreMap.has(normalizedKey)) {
            theatreMap.set(normalizedKey, {
              theatre: theatreName,
              showtimes: [...new Set(times)],
            });
          }
        }
      }
    }
  });

  // Additional pass specifically for Vyjayanthi and UK Cineplex
  lines.forEach((line, index) => {
    const trimmedLine = line.trim();

    // Look specifically for these theatres even without times in the same line
    if (
      trimmedLine.toLowerCase().includes("vyjayanthi") ||
      trimmedLine.toLowerCase().includes("uk cineplex") ||
      (trimmedLine.toLowerCase().includes("uk") &&
        trimmedLine.toLowerCase().includes("cineplex"))
    ) {
      // Look for times in nearby lines
      const nearbyTimes = [];
      for (
        let i = Math.max(0, index - 5);
        i < Math.min(lines.length, index + 10);
        i++
      ) {
        const times = lines[i].match(THEATRE_PATTERNS.TIME_REGEX) || [];
        nearbyTimes.push(...times);
      }

      if (nearbyTimes.length > 0) {
        let theatreName = trimmedLine;

        // Clean up theatre name
        theatreName = theatreName
          .replace(/^[^a-zA-Z]*/, "")
          .replace(/[^a-zA-Z0-9\s\-\.\(\)]*$/, "");

        if (theatreName.length > 3 && theatreName.length < 100) {
          const normalizedKey = theatreName
            .toLowerCase()
            .replace(/[^\w\s]/g, "")
            .replace(/\s+/g, " ")
            .trim();

          if (!theatreMap.has(normalizedKey)) {
            theatreMap.set(normalizedKey, {
              theatre: theatreName,
              showtimes: [...new Set(nearbyTimes)],
            });
          }
        }
      }
    }
  });

  return Array.from(theatreMap.values());
}

/**
 * Optimized movie page analysis
 */
async function analyzeMoviePage(url) {
  console.log("🎬 Analyzing movie page...");
  console.log(`📍 URL: ${url}`);

  const urlAnalysis = analyzeURL(url);
  console.log(`🔍 URL Type: ${urlAnalysis.type}`);

  const { browser, page } = await createBrowser();

  try {
    console.log("🌐 Loading page...");

    try {
      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: CONFIG.BROWSER_TIMEOUT,
      });
    } catch (timeoutError) {
      console.log("⚠️ Trying alternative loading strategy...");
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: CONFIG.BROWSER_TIMEOUT,
      });
      await page.waitForTimeout(3000);
    }

    const pageTitle = await page.title();
    const currentUrl = await page.url();
    console.log(`📄 Page title: ${pageTitle}`);
    console.log(`🔗 Final URL: ${currentUrl}`);

    const pageData = await page.evaluate(() => {
      const pageText = document.body.innerText;
      const pageHTML = document.body.innerHTML;

      // Extract movie title
      const titleElement =
        document.querySelector("h1") ||
        document.querySelector('[data-component-type="movie-title"]') ||
        document.querySelector(".movie-title") ||
        document.querySelector("title");
      const movieTitle = titleElement
        ? titleElement.textContent.trim()
        : "Unknown Movie";

      // Status detection
      const hasInterestedButton =
        pageText.includes("I'm interested") ||
        pageText.includes("Mark interested") ||
        pageHTML.includes("interested");
      const hasBookTicketsButton =
        pageText.includes("Book tickets") || pageText.includes("Book now");
      const hasReleasingText =
        pageText.includes("Releasing on") || pageText.includes("Releasing");

      // Release date extraction
      const releaseDateMatch =
        pageText.match(/Releasing on (\d{1,2} \w{3}, \d{4})/i) ||
        pageText.match(/(\d{1,2} \w{3}, \d{4})/);
      const releaseDate = releaseDateMatch ? releaseDateMatch[1] : null;

      // Comprehensive content extraction function
      const extractAllContent = async () => {
        let allText = "";

        // Function to expand all possible content
        const expandAllContent = () => {
          // Scroll to bottom multiple times to trigger lazy loading
          for (let i = 0; i < 5; i++) {
            window.scrollTo(0, document.body.scrollHeight);
          }

          // Find and click all expansion buttons
          const allButtons = document.querySelectorAll("button, a, div, span");
          allButtons.forEach((button) => {
            const text = button.textContent.toLowerCase();
            if (
              text.includes("show more") ||
              text.includes("load more") ||
              text.includes("view all") ||
              text.includes("expand") ||
              text.includes("see more") ||
              text.includes("load all") ||
              text.includes("show all") ||
              text.includes("view more")
            ) {
              try {
                button.click();
              } catch (e) {
                // Ignore click errors
              }
            }
          });

          // Wait for content to load
          return new Promise((resolve) => setTimeout(resolve, 3000));
        };

        // Expand content multiple times to ensure we get everything
        for (let attempt = 0; attempt < 3; attempt++) {
          await expandAllContent();

          // Get current text content
          const currentText = document.body.innerText;
          if (currentText.length > allText.length) {
            allText = currentText;
          }

          // Also try to get text from specific theatre-related elements
          const theatreElements = document.querySelectorAll(
            '[class*="theatre"], [class*="cinema"], [class*="venue"], [id*="theatre"], [id*="cinema"]'
          );
          theatreElements.forEach((element) => {
            allText += "\n" + element.textContent;
          });
        }

        return allText;
      };

      return extractAllContent().then((bodyText) => ({
        movieTitle,
        releaseDate,
        hasInterestedButton,
        hasBookTicketsButton,
        hasReleasingText,
        bodyText,
      }));
    });

    // Extract theatres using enhanced function
    let theatres = extractTheatresAndShowtimes(pageData.bodyText);

    // Debug information for theatre extraction
    console.log(`🔍 Theatre extraction debug:`);
    console.log(
      `   📄 Total page lines: ${pageData.bodyText.split("\n").length}`
    );
    console.log(`   🎭 Theatres found: ${theatres.length}`);
    if (theatres.length > 0) {
      console.log(
        `   📊 Sample theatres: ${theatres
          .slice(0, 3)
          .map((t) => t.theatre)
          .join(", ")}`
      );
    }

    // Additional debug: Check for theatre-related content in page
    const theatreKeywords = ["theatre", "cinema", "pvr", "inox", "multiplex"];
    const foundKeywords = theatreKeywords.filter((keyword) =>
      pageData.bodyText.toLowerCase().includes(keyword)
    );
    console.log(
      `🔍 Theatre keywords found in page: ${foundKeywords.join(", ")}`
    );

    // Check for time patterns in the page
    const timeMatches =
      pageData.bodyText.match(THEATRE_PATTERNS.TIME_REGEX) || [];
    console.log(`🔍 Time patterns found: ${timeMatches.length}`);

    // Check specifically for Vyjayanthi and UK Cineplex
    const specificTheatres = ["vyjayanthi", "uk cineplex"];
    const foundSpecificTheatres = specificTheatres.filter((theatre) =>
      pageData.bodyText.toLowerCase().includes(theatre)
    );
    if (foundSpecificTheatres.length > 0) {
      console.log(
        `🎯 Target theatres found in page: ${foundSpecificTheatres.join(", ")}`
      );
    } else {
      console.log(
        "⚠️ Target theatres (Vyjayanthi, UK Cineplex) not found in page content"
      );
    }

    // Enhanced fallback: Try multiple strategies to get complete theatre list
    if (theatres.length < 10) {
      console.log(
        "🔄 Theatre count seems low, trying comprehensive extraction..."
      );

      // Strategy 1: Try different page scrolling and expansion
      const additionalContent = await page.evaluate(() => {
        // Scroll multiple times to trigger all lazy loading
        for (let i = 0; i < 10; i++) {
          window.scrollTo(0, document.body.scrollHeight);
          window.scrollTo(0, 0);
        }

        // Click all possible expansion elements
        const allElements = document.querySelectorAll(
          "button, a, div, span, li"
        );
        allElements.forEach((element) => {
          const text = element.textContent.toLowerCase();
          if (
            text.includes("show") ||
            text.includes("load") ||
            text.includes("view") ||
            text.includes("expand") ||
            text.includes("more") ||
            text.includes("all")
          ) {
            try {
              element.click();
            } catch (e) {
              // Ignore click errors
            }
          }
        });

        // Wait for content to load
        return new Promise((resolve) => {
          setTimeout(() => {
            // Get all text content including hidden elements
            let fullText = document.body.innerText;

            // Also get text from specific containers that might contain theatres
            const containers = document.querySelectorAll(
              '[class*="venue"], [class*="theatre"], [class*="cinema"], [class*="showtime"], [class*="booking"]'
            );
            containers.forEach((container) => {
              fullText += "\n" + container.textContent;
            });

            resolve(fullText);
          }, 5000);
        });
      });

      // Strategy 2: Try extraction with additional content
      const additionalTheatres = extractTheatresAndShowtimes(additionalContent);
      console.log(
        `🔄 Additional theatres from enhanced extraction: ${additionalTheatres.length}`
      );

      // Strategy 3: Try alternative parsing approach for missed theatres
      const alternativeTheatres = extractTheatresAlternative(additionalContent);
      console.log(
        `🔄 Alternative parsing found: ${alternativeTheatres.length} theatres`
      );

      // Merge all results
      const allTheatres = [...theatres];

      // Merge additional theatres
      additionalTheatres.forEach((newTheatre) => {
        const exists = allTheatres.some(
          (existing) =>
            existing.theatre
              .toLowerCase()
              .includes(newTheatre.theatre.toLowerCase()) ||
            newTheatre.theatre
              .toLowerCase()
              .includes(existing.theatre.toLowerCase())
        );
        if (!exists) {
          allTheatres.push(newTheatre);
        }
      });

      // Merge alternative theatres
      alternativeTheatres.forEach((newTheatre) => {
        const exists = allTheatres.some(
          (existing) =>
            existing.theatre
              .toLowerCase()
              .includes(newTheatre.theatre.toLowerCase()) ||
            newTheatre.theatre
              .toLowerCase()
              .includes(existing.theatre.toLowerCase())
        );
        if (!exists) {
          allTheatres.push(newTheatre);
        }
      });

      theatres = allTheatres;
      console.log(
        `📊 Total theatres after comprehensive extraction: ${theatres.length}`
      );
    }

    // Determine current status with priority logic
    let currentStatus;
    if (urlAnalysis.type === "released" && theatres.length > 0) {
      currentStatus = "BOOKING_AVAILABLE";
    } else if (
      urlAnalysis.type === "coming-soon" ||
      pageData.hasInterestedButton ||
      pageData.hasReleasingText
    ) {
      currentStatus = "COMING_SOON";
    } else if (
      pageData.hasBookTicketsButton ||
      urlAnalysis.type === "released"
    ) {
      currentStatus = "BOOKING_AVAILABLE";
    } else {
      currentStatus = "UNKNOWN";
    }

    const result = {
      ...pageData,
      theatres,
      currentStatus,
      pageUrl: url,
      urlAnalysis,
    };

    // Console output
    console.log(`🎬 Movie: ${result.movieTitle}`);
    console.log(`📅 Release Date: ${result.releaseDate || "Not specified"}`);
    console.log(`🎯 Status: ${result.currentStatus}`);
    console.log(`🎭 Theatres found: ${result.theatres.length}`);

    if (result.theatres.length === 0) {
      console.log(
        "⏳ Status: Still waiting for release - no theatres showing yet!"
      );
    } else {
      console.log(
        `🎉 Status: LIVE! Movie is now showing in ${result.theatres.length} theatres!`
      );
    }

    return result;
  } finally {
    await browser.close();
  }
}

// ================================
// MESSAGE TEMPLATE FUNCTIONS
// ================================

/**
 * Creates movie-specific celebration messages
 */
function createCelebrationMessage(movieData, movieInfo) {
  const { name, emoji } = movieInfo;
  const theatreCount = movieData.theatres.length;

  const messages = {
    Coolie: `🚂 *COOLIE BOOKING NOW LIVE!* 💪🎉\n\n🔥 ALL ABOARD! The Coolie train has arrived!\n🎬 Action packed journey begins in ${theatreCount} theatres!\n\n🚂 *COOLIE THEATRES (Train stations):*\n\n`,
    "War 2": `💥 *WAR 2 BOOKING NOW LIVE!* 🔥🎉\n\n⚔️ THE BATTLE BEGINS! War has been declared!\n🎬 Epic warfare starts in ${theatreCount} theatres!\n\n💥 *WAR 2 THEATRES (Battlefields):*\n\n`,
  };

  return (
    messages[name] ||
    `🎬 *${movieData.movieTitle}* 🎉\n\n🎭 Now showing in ${theatreCount} theatres!\n\n🎪 *THEATRES & SHOWTIMES:*\n\n`
  );
}

/**
 * Creates call-to-action messages
 */
function createCallToAction(movieName) {
  const actions = {
    Coolie:
      "🚂 All aboard the Coolie express!\n💪 Don't miss this action ride!",
    "War 2":
      "💥 War 2 has launched after the epic wait!\n🔥 Time to join the battle!",
  };

  return actions[movieName] || "🍿 Don't miss out - grab your tickets now!";
}

/**
 * Identifies which hardcoded movie this is
 */
function identifyMovie(url) {
  return HARDCODED_MOVIES.find(
    (movie) =>
      movie.url.includes(movie.name.toLowerCase().replace(/\s+/g, "-")) &&
      url.includes(movie.name.toLowerCase().replace(/\s+/g, "-"))
  );
}

// ================================
// TELEGRAM NOTIFICATION
// ================================

/**
 * Optimized Telegram notification system
 */
async function sendTelegramNotification(movieData, isStatusChange = false) {
  try {
    const movieInfo = identifyMovie(movieData.pageUrl);
    let message;

    if (
      movieData.currentStatus === "BOOKING_AVAILABLE" &&
      movieData.theatres.length > 0
    ) {
      if (isStatusChange && movieInfo) {
        message = createCelebrationMessage(movieData, movieInfo);
      } else {
        message = `🎬 *${movieData.movieTitle}* 🎉\n\n🎭 Now showing in ${movieData.theatres.length} theatres!\n\n🎪 *THEATRES & SHOWTIMES:*\n\n`;
      }

      // Add theatre details
      movieData.theatres.forEach((theatre, index) => {
        message += `${index + 1}. 🎭 *${
          theatre.theatre
        }*\n   ⏰ ${theatre.showtimes.join(", ")}\n\n`;
      });

      // Add call to action
      if (isStatusChange && movieInfo) {
        message += createCallToAction(movieInfo.name);
      }
    } else {
      message = `❓ *${movieData.movieTitle}* - Status Unknown\n\n🔍 Unable to determine booking status\n`;
    }

    message += `🔗 [Movie Page](${movieData.pageUrl})\n`;
    message += `⏰ Last checked: ${new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
    })}`;

    if (movieData.theatres.length > 0) {
      message += `\n📊 Total theatres: ${movieData.theatres.length}`;
    }

    console.log("📱 Sending Telegram notification...");

    const response = await axios.post(
      `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: CONFIG.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown",
        disable_web_page_preview: false,
      }
    );

    if (response.data.ok) {
      console.log("✅ Telegram notification sent successfully!");
    } else {
      throw new Error(`Telegram API error: ${response.data.description}`);
    }
  } catch (error) {
    console.error("❌ Failed to send Telegram notification:", error.message);
    if (error.response) {
      console.error("Telegram API response:", error.response.data);
    }
    throw error;
  }
}

// ================================
// MONITORING FUNCTIONS
// ================================

/**
 * Calculates monitoring interval
 */
function calculateMonitoringInterval() {
  const intervalMs = CONFIG.CHECK_INTERVAL_MINUTES * 60 * 1000;
  console.log(`⏰ Next check in ${CONFIG.CHECK_INTERVAL_MINUTES} minutes`);
  return intervalMs;
}

/**
 * Monitors all hardcoded movies
 */
async function monitorAllMovies(movies, runOnce = false) {
  const lastStatuses = new Map();

  const processAllMovies = async () => {
    try {
      console.log("🔄 Starting multi-movie check cycle...");
      console.log("=====================================\n");

      for (let i = 0; i < movies.length; i++) {
        const movie = movies[i];
        console.log(
          `${movie.emoji} Checking ${movie.name} (${i + 1}/${movies.length}):`
        );
        console.log("━".repeat(44) + "\n");

        try {
          const movieData = await analyzeMoviePage(movie.url);
          const lastStatus = lastStatuses.get(movie.url);
          const isStatusChange =
            lastStatus && lastStatus.currentStatus !== movieData.currentStatus;

          if (isStatusChange) {
            console.log(
              `🚨 STATUS CHANGE: ${lastStatus.currentStatus} → ${movieData.currentStatus}`
            );
          }

          // Send notification only when theatres are found
          if (
            movieData.theatres.length > 0 &&
            (isStatusChange ||
              !lastStatus ||
              movieData.currentStatus === "BOOKING_AVAILABLE")
          ) {
            console.log(
              "📱 Sending Telegram notification for theatre availability..."
            );
            await sendTelegramNotification(movieData, isStatusChange);
          } else if (movieData.theatres.length === 0) {
            console.log(
              "⏳ No theatres found yet - waiting for booking to open (no notification sent)"
            );
          }

          // Display results
          if (movieData.theatres.length > 0) {
            console.log("\n🎭 Theatre Results (where the movie is playing):");
            console.log("=============================================");
            movieData.theatres.forEach((theatre, index) => {
              console.log(`${index + 1}. 🎬 ${theatre.theatre}`);
              console.log(`   ⏰ Showtimes: ${theatre.showtimes.join(", ")}`);
            });
            console.log(
              `\n🎉 Movie is now showing in ${movieData.theatres.length} theatres!`
            );
          } else {
            console.log("\n⏳ Status Update:");
            console.log("================");
            console.log("🎬 Movie is still preparing for release...");
            console.log("⏳ Waiting for theatres to start showing!");
            console.log("🍿 Patience - the show will begin soon!");
          }

          lastStatuses.set(movie.url, movieData);
          console.log("✅ Single run completed successfully!");

          if (i < movies.length - 1) {
            console.log("⏳ Waiting 3 seconds before next movie...\n");
            await new Promise((resolve) =>
              setTimeout(resolve, CONFIG.RETRY_DELAY)
            );
          }
        } catch (error) {
          console.error(`❌ Error checking ${movie.name}:`, error.message);
        }
      }

      console.log("\n✅ Multi-movie check cycle completed!");

      if (!runOnce) {
        const interval = calculateMonitoringInterval();
        console.log(
          `⏱️ Next multi-movie check in ${CONFIG.CHECK_INTERVAL_MINUTES} minutes`
        );
        setTimeout(processAllMovies, interval);
      } else {
        console.log("🎬 Single run of all movies completed successfully!");
      }
    } catch (error) {
      console.error("❌ Error in multi-movie monitoring:", error.message);
      if (!runOnce) {
        console.log("🔄 Retrying in 10 minutes...");
        setTimeout(processAllMovies, 10 * 60 * 1000);
      }
    }
  };

  processAllMovies();
}

/**
 * Smart scraper for single movie monitoring
 */
async function smartScraper(movieUrl, runOnce = false) {
  const lastStatus = { currentStatus: null };

  const processMovie = async () => {
    try {
      console.log("🔄 Processing movie...");
      const movieData = await analyzeMoviePage(movieUrl);
      const isStatusChange =
        lastStatus.currentStatus &&
        lastStatus.currentStatus !== movieData.currentStatus;

      if (isStatusChange) {
        console.log(
          `🚨 STATUS CHANGE: ${lastStatus.currentStatus} → ${movieData.currentStatus}`
        );
      }

      // Send notification only when theatres are found
      if (
        movieData.theatres.length > 0 &&
        (isStatusChange ||
          !lastStatus.currentStatus ||
          movieData.currentStatus === "BOOKING_AVAILABLE")
      ) {
        console.log(
          "📱 Sending Telegram notification for theatre availability..."
        );
        await sendTelegramNotification(movieData, isStatusChange);
      } else if (movieData.theatres.length === 0) {
        console.log(
          "⏳ No theatres found yet - waiting for booking to open (no notification sent)"
        );
      }

      // Display results
      if (movieData.theatres.length > 0) {
        console.log("\n🎭 Theatre Results (where the movie is playing):");
        console.log("=============================================");
        movieData.theatres.forEach((theatre, index) => {
          console.log(`${index + 1}. 🎬 ${theatre.theatre}`);
          console.log(`   ⏰ Showtimes: ${theatre.showtimes.join(", ")}`);
        });
        console.log(
          `\n🎉 Movie is now showing in ${movieData.theatres.length} theatres!`
        );
      } else {
        console.log("\n⏳ Status Update:");
        console.log("================");
        console.log("🎬 Movie is still preparing for release...");
        console.log("⏳ Waiting for theatres to start showing!");
        console.log("🍿 Patience - the show will begin soon!");
      }

      lastStatus.currentStatus = movieData.currentStatus;

      if (!runOnce) {
        const interval = calculateMonitoringInterval();
        console.log(
          `⏱️ Next check in ${CONFIG.CHECK_INTERVAL_MINUTES} minutes`
        );
        setTimeout(processMovie, interval);
      } else {
        console.log("✅ Single run completed successfully!");
      }
    } catch (error) {
      console.error("❌ Error processing movie:", error.message);

      // Send error notification
      try {
        const errorMessage = `🚨 *Smart Scraper Error*\n\nError: ${
          error.message
        }\n\nTime: ${new Date().toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
        })}`;
        await sendTelegramNotification(
          {
            movieTitle: "Scraper Error",
            currentStatus: "ERROR",
            pageUrl: movieUrl,
            theatres: [],
          },
          true
        );
      } catch (telegramError) {
        console.error(
          "Failed to send error notification:",
          telegramError.message
        );
      }

      if (!runOnce) {
        console.log("🔄 Retrying in 10 minutes...");
        setTimeout(processMovie, 10 * 60 * 1000);
      }
    }
  };

  processMovie();
}

// ================================
// MAIN ENTRY POINT
// ================================

if (require.main === module) {
  const args = process.argv.slice(2);
  const runOnce = args.includes("--once");
  const useHardcoded =
    args.includes("--all") ||
    args.includes("--kingdom") ||
    args.length === 0 ||
    (args.length === 1 && args[0] === "--once");

  let movieUrl = args.find((arg) => arg.startsWith("http"));

  // Display startup information
  if (useHardcoded || !movieUrl) {
    console.log("🎬 Using hardcoded movie URLs for automatic monitoring");
    console.log(
      `📋 Monitoring ${HARDCODED_MOVIES.length} movies: ${HARDCODED_MOVIES.map(
        (m) => m.name
      ).join(", ")}`
    );
  }

  if (!movieUrl && !useHardcoded) {
    console.error("❌ Please provide a movie URL or use hardcoded monitoring");
    console.log("\nUsage:");
    console.log(
      "  node smart-scraper.js                    # Monitor all hardcoded movies"
    );
    console.log(
      "  node smart-scraper.js --all              # Monitor all movies (explicit)"
    );
    console.log(
      '  node smart-scraper.js "MOVIE_URL"        # Monitor specific movie'
    );
    console.log('  node smart-scraper.js "MOVIE_URL" --once # Single run only');
    process.exit(1);
  }

  console.log("🚀 BookMyShow Smart Scraper");
  console.log("============================");

  if (useHardcoded || !movieUrl) {
    console.log("🎬 MULTI-MOVIE MONITORING");
    console.log(`📋 Tracking ${HARDCODED_MOVIES.length} Epic Movies:`);
    HARDCODED_MOVIES.forEach((movie, index) => {
      console.log(
        `${index + 1}. ${movie.emoji} ${movie.name} - ${movie.releaseDate}`
      );
    });
    console.log("🎯 Will alert when any movie booking opens");
  } else {
    console.log(`📍 Movie URL: ${movieUrl}`);
  }

  console.log(`🔄 Mode: ${runOnce ? "Single Run" : "Continuous Monitoring"}`);
  console.log("");

  validateConfig();

  // Start monitoring
  if (useHardcoded || !movieUrl) {
    monitorAllMovies(HARDCODED_MOVIES, runOnce);
  } else {
    smartScraper(movieUrl, runOnce);
  }
}

module.exports = {
  analyzeURL,
  analyzeMoviePage,
  sendTelegramNotification,
  smartScraper,
  CONFIG,
  HARDCODED_MOVIES,
};
