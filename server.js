const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { create } = require('xmlbuilder2');
const cors = require('cors');
let sitemapUrlCount = 0;
const app = express();
app.set('trust proxy', true);
const port = process.env.PORT || 3002;
const rateLimit = require('express-rate-limit');

// Add rate limiting to prevent overloading the website
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50, // limit each IP to 100 requests per windowMs
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    store: new rateLimit.MemoryStore(), // Use memory store for rate limiting
    keyGenerator: function (req) {
        // Use the real IP address from Heroku's proxy
        return req.headers['x-forwarded-for'] || req.ip;
    }
});

app.use(limiter);

app.use(cors());
app.use(express.json());

// Helper function to extract domain from URL
function getDomain(url) {
    const match = url.match(/^(?:https?:\/\/)?(?:[^@\n]+@)?(?:www\.)?([^:\/\n]+)/);
    return match ? match[1] : null;
}

// Helper function to check if URL belongs to the same domain
function isSameDomain(baseUrl, url) {
    const baseDomain =  getDomain(baseUrl);
    const urlDomain =  getDomain(url);
    return baseDomain === urlDomain;
}

// Helper function to crawl a URL
async function crawlUrl(url, res, visitedUrls, addedUrls) {
    try {
        // Check if URL is already visited
        if (visitedUrls.has(url)) {
            console.log(`Skipping already visited URL: ${url}`);
            return { success: false, url, error: 'Already visited' };
        }

        // Add delay between requests to be polite
        await delay(1000);

        console.log(`Crawling URL: ${url}`);

        // Send progress update
        if (res) {
            res.write(`data: ${JSON.stringify({ type: 'progress', url, status: 'crawling' })}\n\n`);
        }

        // Make the request with proper error handling
        try {
            const response = await axios.get(url, {
                maxRedirects: 5,
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1'
                },
                validateStatus: function (status) {
                    return status >= 200 && status < 400; // Accept all 2xx status codes
                }
            });

            if (!response) {
                return { success: false, url, error: 'No response' };
            }

            // Check if we got HTML content
            if (!response.data || !response.data.includes('<html')) {
                console.log(`Skipping non-HTML content at ${url}`);
                return { success: false, url, error: 'Not HTML content' };
            }

            // Parse the HTML and extract links
            const $ = cheerio.load(response.data);
            const childUrls = new Set();
            const baseUrl = 'https://' + getDomain(url);

            // Extract links from the page
            $('a').each((index, element) => {
                const href = $(element).attr('href');
                if (!href) return;

                // Normalize URL
                let fullUrl;
                if (!href.startsWith('http')) {
                    try {
                        fullUrl = new URL(href, baseUrl).href;
                    } catch (e) {
                        console.log(`Skipping invalid URL at index ${index}: ${href}`);
                        return;
                    }
                } else {
                    fullUrl = href;
                }

                // Remove query parameters
                const urlObj = new URL(fullUrl);
                urlObj.search = '';
                const normalizedUrl = urlObj.toString();

                // Add to child URLs if it's within the same domain and not already visited
                if ('https://' + getDomain(normalizedUrl) === baseUrl && !visitedUrls.has(normalizedUrl)) {
                    childUrls.add(normalizedUrl);
                }
            });

            // Add URL to visited set
            visitedUrls.add(url);
            addedUrls.add(url);
            sitemapUrlCount++;

            // Send progress update
            if (res) {
                res.write(`data: ${JSON.stringify({
                    type: 'success',
                    url,
                    childCount: childUrls.size
                })}\n\n`);
            }

            return { success: true, url, childUrls: Array.from(childUrls) };

        } catch (error) {
            console.error(`Error processing URL ${url}:`, error);
            return { success: false, url, error: error.message };
        }
    } catch (error) {
        console.error(`Error crawling URL ${url}:`, error);
        return { success: false, url, error: error.message };
    }
}

// Function to crawl website and generate sitemap
async function generateSitemap(url, res, maxUrls) {
    try {
        // Initialize variables
        const urlsToVisit = new Set([url]);
        const visitedUrls = new Set();
        const maxAttempts = 200;
        const maxPagesPerParent = 15;
        const maxConcurrentRequests = 10;
        const rateLimitWindow = 300;
        const maxRequestsPerWindow = 50;
        const maxDepth = 10; // Reduced from 5 to 3
        const maxSitemapUrls = maxUrls || 500; // Reduced default from 1000 to 500
        const maxUrlsPerBatch = 100; // New limit for URLs processed per batch
        let attempts = 0;
        let requestCount = 0;
        let lastRequestTime = Date.now();
        let sitemapUrlCount = 0;

        // Log initial memory usage
        const initialMemUsage = process.memoryUsage();
        console.log('Initial memory usage:', {
            rss: Math.round(initialMemUsage.rss / 1024 / 1024),
            heapTotal: Math.round(initialMemUsage.heapTotal / 1024 / 1024),
            heapUsed: Math.round(initialMemUsage.heapUsed / 1024 / 1024),
            external: Math.round(initialMemUsage.external / 1024 / 1024)
        }, 'MB');

        // Track URL depth
        const urlDepthMap = new Map();
        urlDepthMap.set(url, 0);

        // Track parent-child relationships
        const parentChildMap = new Map();
        const parentCounts = new Map();
        const addedUrls = new Set();

        // Main crawling loop
        while (urlsToVisit.size > 0 && attempts < maxAttempts) {
            // Rate limiting
            const currentTime = Date.now();
            const timeSinceLastRequest = currentTime - lastRequestTime;
            if (timeSinceLastRequest < rateLimitWindow) {
                const waitTime = rateLimitWindow - timeSinceLastRequest;
                try {
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                } catch (error) {
                    console.error('Error waiting for rate limit:', error);
                }
            }
            lastRequestTime = currentTime;

            // Get a batch of URLs to process
            const urlsBatch = Array.from(urlsToVisit).slice(0, maxConcurrentRequests);

            // Process the batch
            const results = await Promise.all(
                urlsBatch.map(async (url) => {
                    try {
                        // Get URL depth
                        const depth = urlDepthMap.get(url) || 0;

                        // Skip if we've reached max depth
                        if (depth > maxDepth) {
                            console.log(`Skipping URL ${url} - max depth (${maxDepth}) reached`);
                            return { success: false, url, error: 'Max depth reached' };
                        }

                        // Process the URL
                        const result = await crawlUrl(url, res, visitedUrls, addedUrls);

                        if (!result) {
                            return { success: false, url, error: 'No result' };
                        }

                        return result;
                    } catch (error) {
                        console.error(`Error in crawlUrl:`, error);
                        return { success: false, url, error: error.message };
                    }
                })
            );

            // Process results
            for (const result of results) {
                if (result.success) {
                    // Log memory usage after processing batch
                    const batchMemUsage = process.memoryUsage();
                    console.log('Memory usage after batch:', {
                        rss: Math.round(batchMemUsage.rss / 1024 / 1024),
                        heapTotal: Math.round(batchMemUsage.heapTotal / 1024 / 1024),
                        heapUsed: Math.round(batchMemUsage.heapUsed / 1024 / 1024),
                        external: Math.round(batchMemUsage.external / 1024 / 1024)
                    }, 'MB', {
                        urlsToVisit: urlsToVisit.size,
                        visitedUrls: visitedUrls.size,
                        urlDepthMap: urlDepthMap.size,
                        parentChildMap: parentChildMap.size,
                        parentCounts: parentCounts.size
                    });
                    // Add child URLs to visit
                    for (const childUrl of result.childUrls) {
                        // Skip if URL is already visited or in urlsToVisit
                        if (visitedUrls.has(childUrl)) {
                            console.log(`Skipping URL ${childUrl} - already visited`);
                            continue;
                        }
                        if (urlsToVisit.has(childUrl)) {
                            console.log(`Skipping URL ${childUrl} - already in queue`);
                            continue;
                        }

                        // Check if we've reached max depth
                        const parentUrl = result.url;
                        const parentDepth = urlDepthMap.get(parentUrl) || 0;
                        const childDepth = parentDepth + 1;

                        // Check if we've reached max depth
                        if (childDepth <= maxDepth) {
                            // Check if we've reached max pages per parent
                            const parentCount = parentCounts.get(parentUrl) || 0;
                            const isHomePage = parentUrl === url;

                            // Allow unlimited child pages for home page
                            const isWithinLimit = isHomePage || parentCount < maxPagesPerParent;

                            if (isWithinLimit) {
                                // Add URL to urlsToVisit if we haven't reached our batch limit
                                if (urlsToVisit.size < maxUrlsPerBatch) {
                                    urlsToVisit.add(childUrl);
                                    urlDepthMap.set(childUrl, childDepth);

                                    // Track parent-child relationship
                                    if (!parentChildMap.has(parentUrl)) {
                                        parentChildMap.set(parentUrl, new Set());
                                    }
                                    parentChildMap.get(parentUrl).add(childUrl);

                                    // Update parent count
                                    parentCounts.set(parentUrl, parentCount + 1);
                                } else {
                                    console.log(`Skipping URL ${childUrl} - batch limit (${maxUrlsPerBatch}) reached`);
                                }
                            } else {
                                console.log(`Skipping URL ${childUrl} - max pages per parent (${maxPagesPerParent}) reached`);
                            }
                        } else {
                            console.log(`Skipping URL ${childUrl} - max depth (${maxDepth}) reached`);
                        }
                    }
                } else {
                    console.error(`Failed to crawl ${result.url}: ${result.error}`);
                }
            }

            // Remove processed URLs from all sets to free memory
            urlsBatch.forEach(url => {
                urlsToVisit.delete(url);
                // visitedUrls.delete(url); // Keeping visited URLs for deduplication
                urlDepthMap.delete(url);
                if (parentChildMap.has(url)) {
                    parentChildMap.delete(url);
                }
                if (parentCounts.has(url)) {
                    parentCounts.delete(url);
                }
            });

            // Log memory usage after cleanup
            const cleanupMemUsage = process.memoryUsage();
            console.log('Memory usage after cleanup:', {
                rss: Math.round(cleanupMemUsage.rss / 1024 / 1024),
                heapTotal: Math.round(cleanupMemUsage.heapTotal / 1024 / 1024),
                heapUsed: Math.round(cleanupMemUsage.heapUsed / 1024 / 1024),
                external: Math.round(cleanupMemUsage.external / 1024 / 1024)
            }, 'MB', {
                urlsToVisit: urlsToVisit.size,
                visitedUrls: visitedUrls.size,
                urlDepthMap: urlDepthMap.size,
                parentChildMap: parentChildMap.size,
                parentCounts: parentCounts.size
            });

            // If we've processed all URLs, reached max attempts, or reached max sitemap URLs, break the loop
            if (urlsToVisit.size === 0 || attempts >= maxAttempts || sitemapUrlCount >= maxSitemapUrls) {
                break;
            }

            attempts++;
        }

        // Log final memory usage before building sitemap
        const finalMemUsage = process.memoryUsage();
        console.log('Final memory usage before sitemap:', {
            rss: Math.round(finalMemUsage.rss / 1024 / 1024),
            heapTotal: Math.round(finalMemUsage.heapTotal / 1024 / 1024),
            heapUsed: Math.round(finalMemUsage.heapUsed / 1024 / 1024),
            external: Math.round(finalMemUsage.external / 1024 / 1024)
        }, 'MB', {
            urlsToVisit: urlsToVisit.size,
            visitedUrls: visitedUrls.size,
            urlDepthMap: urlDepthMap.size,
            parentChildMap: parentChildMap.size,
            parentCounts: parentCounts.size
        });

        // Build the sitemap XML
        const builder = create({
            version: '1.0',
            encoding: 'UTF-8',
            standalone: true
        }).ele('urlset', { xmlns: 'http://www.sitemaps.org/schemas/sitemap/0.9' });

        // Add URLs to sitemap
        Array.from(addedUrls).forEach(url => {
            const urlElement = builder.ele('url');
            urlElement.ele('loc').txt(url);

        });

        // Send final sitemap
        if (res) {
            res.write(`data: ${JSON.stringify({
                type: 'final_sitemap',
                sitemap: builder.end({ prettyPrint: true })
            })}\n\n`);
            res.end();
        }

        return builder.end({ prettyPrint: true });
    } catch (error) {
        console.error('Error in sitemap generation:', error);
        return { success: false, error: error.message };
    }
}

// POST endpoint for generating sitemap with streaming
app.post('/generate-sitemap', async (req, res) => {
    try {
        const { url, maxUrls } = req.body;
        if (!url) {
            res.write(`data: ${JSON.stringify({
                type: 'error',
                message: 'URL is required'
            })}\n\n`);
            res.end();
            return;
        }

        // Validate URL
        try {
            new URL(url);
        } catch (error) {
            res.write(`data: ${JSON.stringify({
                type: 'error',
                message: 'Invalid URL format'
            })}\n\n`);
            res.end();
            return;
        }

        // Start sitemap generation
        generateSitemap(url, res, maxUrls).catch(error => {
            res.write(`data: ${JSON.stringify({
                type: 'error',
                message: error.message
            })}\n\n`);
            res.end();
        });
    } catch (error) {
        console.error('Error in /generate endpoint:', error);
        res.write(`data: ${JSON.stringify({
            type: 'error',
            message: error.message
        })}\n\n`);
        res.end();
    }
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Sitemap Generator</title>
  <style>
    body {
      font-family: sans-serif;
      margin: 2rem;
    }
    input, button, textarea {
      font-size: 1rem;
      margin-top: 1rem;
    }
    textarea {
      width: 100%;
      height: 300px;
      margin-top: 1rem;
    }
  </style>
</head>
<body>
  <h1>🕸️ Product Sitemap Generator</h1>
  <label for="urlInput">Enter a URL to crawl:</label><br>
  <input type="text" id="urlInput" placeholder="https://example.com/shop" style="width: 400px;" />
  <button onclick="generateSitemap()">Generate Sitemap</button>

  <h2>🧾 Sitemap XML</h2>
  <textarea id="output" readonly></textarea>

  <script>
    async function generateSitemap() {
      const url = document.getElementById('urlInput').value;
      const output = document.getElementById('output');
      output.value = 'Loading...';

      try {
        const response = await fetch('/api/sitemap', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });

        if (!response.ok) {
          throw new Error(await response.text());
        }

        const xml = await response.text();
        output.value = xml;
      } catch (err) {
        output.value = 'Error: ' + err.message;
      }
    }
  </script>
</body>
</html>
        `);
})

// Rate limiting helper function
const delay = async (waitTime) => {
    return new Promise(resolve => setTimeout(resolve, waitTime));
};

// Start server
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
