import { OpenAIService } from './OpenAIService';
import { prompt as askDomainsPrompt } from '../prompts/webSearch/askDomains';
import type { AllowedDomain, IDoc, Query, SearchResult, WebContent } from '../types/types';
import { prompt as useSearchPrompt } from '../prompts/webSearch/useSearch';
import { v4 as uuidv4 } from 'uuid';
import { prompt as selectResourcesToLoadPrompt } from '../prompts/webSearch/pickResources';
import { TextService } from './TextService';
import FirecrawlApp from '@mendable/firecrawl-js';


import type { ChatCompletion, ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";

type SearchNecessityResponse = {
  _thoughts: string;
  shouldSearch: boolean;
};

export class WebSearchService {
  private openaiService: OpenAIService;
  private textService: TextService;
  private allowedDomains: AllowedDomain[];
  private apiKey: string;
  private firecrawlApp: FirecrawlApp;

  constructor() {
    this.openaiService = new OpenAIService();
    this.textService = new TextService();
    this.allowedDomains = [
      { name: 'Laravel', url: 'laravel.com/docs/11.x', scrappable: true },
      // Set here your available domains
    ];
    this.apiKey = process.env.FIRECRAWL_API_KEY || '';
    this.firecrawlApp = new FirecrawlApp({ apiKey: this.apiKey });
  }

  async isWebSearchNeeded(messages: ChatCompletionMessageParam[]) {
     const systemPrompt: ChatCompletionMessageParam = {
      role: 'system',
      content: useSearchPrompt()
    };

    const response = await this.openaiService.completion({
      messages: [systemPrompt, ...messages],
      model: 'gpt-4o',
      jsonMode: true
    }) as ChatCompletion;
    if (response.choices[0].message.content) {
      return JSON.parse(response.choices[0].message.content) as SearchNecessityResponse;
    }
    return { shouldSearch: false };
  }

  async generateQueries(messages: ChatCompletionMessageParam[]): Promise<{ queries: Query[], thoughts: string }> {
    const systemPrompt: ChatCompletionMessageParam = {
      role: "system",
      content: askDomainsPrompt(this.allowedDomains)
    };

    try {
      const response = await this.openaiService.completion({
        messages: [systemPrompt, ...messages],
        model: 'gpt-4o',
        jsonMode: true
      }) as ChatCompletion;

      const result = JSON.parse(response.choices[0].message.content as string);

      console.log('result', result);
      
      const filteredQueries = result.queries.filter((query: { q: string, url: string }) => 
        this.allowedDomains.some(domain => query.url.includes(domain.url))
      );
      return { queries: filteredQueries, thoughts: result._thoughts };

    } catch (error) {
      console.error('Error generating queries:', error);
      return { queries: [], thoughts: '' };
    }
  }

  async searchWeb(queries: Query[], conversation_uuid?: string): Promise<SearchResult[]> {
    const searchResults = await Promise.all(queries.map(async ({ q, url }) => {
      try {
        const domain = new URL(url.startsWith('https://') ? url : `https://${url}`);
        const siteQuery = `site:${domain.hostname.replace(/\/$/, '')} ${q}`;
        const response = await fetch('https://api.firecrawl.dev/v0/search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`
          },
          body: JSON.stringify({
            query: siteQuery,
            searchOptions: {
              limit: 6
            },
            pageOptions: {
              fetchPageContent: false
            }
          })
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();

        if (result.success && result.data && Array.isArray(result.data)) {

          return {
            query: q,
            domain: domain.href,
            results: result.data.map((item: any) => ({
              url: item.url,
              title: item.title,
              description: item.description
            }))
          };
        } else {
          console.warn(`No results found for query: "${siteQuery}"`);
          return { query: q, domain: domain.href, results: [] }; 
        }
      } catch (error) {
        console.error(`Error searching for "${q}":`, error);
        return { query: q, domain: url, results: [] };
      }
    }));

    return searchResults;
  }

  async selectResourcesToLoad(
    messages: ChatCompletionMessageParam[],
    filteredResults: SearchResult[]
  ): Promise<string[]> {
    const systemPrompt: ChatCompletionMessageParam = {
      role: "system",
      content: selectResourcesToLoadPrompt({ resources: filteredResults })
    };

    try {
      const response = await this.openaiService.completion({
        messages: [systemPrompt, ...messages],
        model: 'gpt-4o',
        jsonMode: true
      }) as ChatCompletion;

      if (response.choices[0].message.content) {
        const result = JSON.parse(response.choices[0].message.content);
        const selectedUrls = result.urls;

        console.log('selectedUrls', selectedUrls);

        const validUrls = selectedUrls.filter((url: string) => 
          filteredResults.some(r => r.results.some(item => item.url === url))
        );

        const emptyDomains = filteredResults
          .filter(r => r.results.length === 0)
          .map(r => r.domain);

        const combinedUrls = [...validUrls, ...emptyDomains];

        return combinedUrls;
      }
      throw new Error('Unexpected response format');
    } catch (error) {
      console.error('Error selecting resources to load:', error);
      return [];
    }
  }

  async scrapeUrls(urls: string[], conversation_uuid: string): Promise<WebContent[]> {

    console.log('Input (scrapeUrls):', urls);

    const scrappableUrls = urls.filter(url => {
      const domain = new URL(url).hostname.replace(/^www\./, '');
      const allowedDomain = this.allowedDomains.find(d => d.url === domain);
      return allowedDomain && allowedDomain.scrappable;
    });

    const scrapePromises = scrappableUrls.map(async (url) => {
      try {
        url = url.replace(/\/$/, '');

        const scrapeResult = await this.firecrawlApp.scrapeUrl(url, { formats: ['markdown'] });
        
        if ('markdown' in scrapeResult && scrapeResult.markdown) {
          return { url, content: scrapeResult.markdown.trim() };
        } else {
          console.warn(`No markdown content found for URL: ${url}`);
          return { url, content: '' };
        }
      } catch (error) {
        console.error(`Error scraping URL ${url}:`, error);
        return { url, content: '' };
      }
    });

    const scrapedResults = await Promise.all(scrapePromises);

    return scrapedResults.filter(result => result.content !== '');
  }

  async search(query: string, conversation_uuid: string): Promise<IDoc[]> {
    const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: query }];

    const { queries } = await this.generateQueries(messages);

    console.table(queries.map((query, index) => ({
      'Query Number': index + 1,
      'Query': query
    })));

    let docs: IDoc[] = [];

    if (queries.length > 0) {
      const searchResults = await this.searchWeb(queries, conversation_uuid);

      console.log('searchResults', searchResults.map(r => r.results.map(item => item.title + ' ' + item.url)));

      const resources = await this.selectResourcesToLoad(messages, searchResults);
      const scrapedContent = await this.scrapeUrls(resources, conversation_uuid);

      docs = await Promise.all(searchResults.flatMap(searchResult => 
        searchResult.results.map(async (result) => {
          // Normalize URLs by removing trailing slashes
          const normalizedResultUrl = result.url.replace(/\/$/, '');
          const scrapedItem = scrapedContent.find(item => item.url.replace(/\/$/, '') === normalizedResultUrl);
          const content = scrapedItem ? scrapedItem.content : result.description;
          
          const doc = await this.textService.document(content, 'gpt-4o', {
            name: `${result.title}`,
            description: `This is a result of a web search for the query: "${searchResult.query}"`,
            source: result.url,
            content_type: scrapedItem ? 'complete' : 'chunk',
            uuid: uuidv4(),
            conversation_uuid,
          });

          return doc;
        })
      ));
    }

    return docs;
  }
}
