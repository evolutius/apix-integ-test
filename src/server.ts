import {
  AppManager,
  EndpointMethod,
  MethodCharacteristic,
  DataManager,
  AccessLevelEvaluator,
  RedisStore,
  ApiXConfig,
  RequestInputSchema,
  CacheValue,
  HttpBodyValidator,
  UrlQueryParameterValidator,
  UrlQueryParameterProcessor,
  UrlQueryParameterPassthroughProcessor,
  UrlQueryParameter,
  HttpHeaders,
  Request,
  Response,
  MetricManager,
  MetricManagerOptions,
  MetricTags,
  EndpointGenerator,
  Route,
  PublicResource,
  HttpBody,
  AuthRequired,
  OwnerEvaluator,
  QueryParameters,
  BaseEndpointGenerator
} from '@evlt/apix';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

dotenv.config();

const getAuthToken = <
  QuerySchema extends RequestInputSchema,
  BodySchema extends RequestInputSchema
>(req: Request<QuerySchema, BodySchema>): string | undefined => {
  return req.header(HttpHeaders.AuthToken)?.split(' ')[1];
}

//// Types ////
interface Quote {
  readonly id: string;
  readonly content: string;
  readonly author: string;
  readonly date: string;
  readonly ownerUserId: string;
}

//// END OF Types ////

//// Data Configuration ////

const QUOTES: Record<string, Quote> = {
  "0": {
    id: '0',
    content: 'I think, therefore I am.',
    author: 'René Descartes',
    date: '1637',
    ownerUserId: 'apix@evoluti.us'
  },
  "1": {
    id: '1',
    content: 'The only thing we have to fear is fear itself.',
    author: 'Franklin D. Roosevelt',
    date: 'March 4, 1933',
    ownerUserId: 'apix@evoluti.us'
  },
  "2": {
    id: '2',
    content: 'To be, or not to be, that is the question.',
    author: 'William Shakespeare',
    date: '1600',
    ownerUserId: 'apix@evoluti.us'
  },
  "3": {
    id: '3',
    content: 'The unexamined life is not worth living.',
    author: 'Socrates',
    date: '399 BCE',
    ownerUserId: 'apix@evoluti.us'
  },
  "4": {
    id: '4',
    content: 'Give me liberty, or give me death!',
    author: 'Patrick Henry',
    date: 'March 23, 1775',
    ownerUserId: 'apix@evoluti.us'
  },
  "5": {
    id: '5',
    content: 'Hisashiburi da na, Mugiwara.',
    author: 'Crocodile',
    date: '800 PVC',
    ownerUserId: 'apix@evoluti.us'
  },
  "6": {
    id: '6',
    content: 'Injustice anywhere is a thread to justice everywhere.',
    author: 'Martin Luther King Jr.',
    date: 'April 16, 1963',
    ownerUserId: 'apix@evoluti.us'
  },
  "7": {
    id: '7',
    content: 'I went to the woods because I wished to live deliberately, to front only the essential facts of life, and see if I could not learn what it had to teach, and not, when I came to die, discover that I had not lived.',
    author: 'Henry David Thoreau',
    date: '1854',
    ownerUserId: 'apix@evoluti.us'
  },
  "8": {
    id: '8',
    content: 'All the world’s a stage, and all the men and women merely players.',
    author: 'William Shakespeare',
    date: '1599',
    ownerUserId: 'apix@evoluti.us'
  }
};

class TestDataManager implements DataManager {
  getAppKeyForApiKey(apiKey: string): string | Promise<string> | null {
    /// single app has access
    return apiKey === process.env.API_KEY ? process.env.APP_KEY! : null;
  }

  login(username: string, password: string): string | undefined {
    if (username.toLowerCase() === process.env.USERNAME?.toLowerCase()
      && password === process.env.PASSWORD) {
      const payload = {
        username: username.toLowerCase()
      };

      const token = jwt.sign(payload, process.env.JWT_KEY!, {
        expiresIn: '1h'
      });

      return token;
    }
    return undefined;
  }

  verifyToken(token: string): string | jwt.JwtPayload | undefined {
    try {
      return jwt.verify(token, process.env.JWT_KEY!);
    } catch {
      return undefined;
    }
  }

  async getQuoteWithId(id: string): Promise<Quote | undefined> {
    let quote = await cache.valueForKey(`quote:${id}`) as unknown as Quote;
    if (quote === undefined || quote === null || Object.keys(quote).length === 0) {
      quote = QUOTES[id];
      if (quote) {
        await cache.setValueForKey(quote as unknown as Record<string, unknown>, `quote:${id}`);
      }
    }
    return quote;
  }

  addQuote(content: string, author: string, date: string): Quote {
    const id = `${Object.keys(QUOTES).length}`;
    const quote: Quote = {
      id,
      date,
      content,
      author,
      ownerUserId: 'newb'
    };
    QUOTES[id] = quote;
    return quote;
  }

  deleteQuote(id: string) {
    if (QUOTES[id]) {
      delete QUOTES[id];
    } else {
      throw new Error(`No quote with ID ${id} found.`)
    }
  }

  searchQuotes(
    searchTerm: string,
    author?: string,
    sortKey?: string,
    ascendingSort: boolean = true
  ): Array<Quote> {
    const quotes = Object.values(QUOTES)
      .filter(quote => quote.content.toLowerCase().includes(searchTerm.toLowerCase()))
      .filter(quote => author ? quote.author.toLowerCase() === author.toLowerCase() : true);
    const validKeys = ['date', 'content', 'author'];
    if (quotes.length > 0 && sortKey && validKeys.includes(sortKey)) {
      const multiplier = ascendingSort ? 1 : -1;
      quotes.sort((a, b) => {
        switch (sortKey) {
          case 'date':
            return multiplier * (a.date > b.date ? 1 : -1);
          case 'content':
            return multiplier * (a.content > b.content ? 1 : -1);
          case 'author':
            return multiplier * (a.author > b.author ? 1 : -1);
          default:
            return 0;
        }
      });
    }
    return quotes;
  }
}

const dataManager = new TestDataManager();

//// END OF Data Configuration ////

const cache = new RedisStore();

cache.connect()
  .then(() => {
    console.log(`\x1b[32mConnected to cache successfully.\x1b[0m`);
  })
  .catch(error => {
    console.error(`\x1b[31mFailed to connect to cache:\x1b[0m`);

    if (error instanceof Error) {
      console.error(`${error.name}: ${error.stack}`);
    }
    
    process.exit(1);
  });

//// Methods and Schema Definitions ////

interface SetCacheValueSchema extends RequestInputSchema {
  readonly key: string;
  readonly value: CacheValue;
  readonly ttl?: number;
}

class SetCacheValueBodyValidator implements HttpBodyValidator<SetCacheValueSchema> {
  isValid(body: SetCacheValueSchema): boolean {
    return body.key !== undefined && body.key !== null
      && body.value !== undefined && body.value !== null;
  }
}

@EndpointGenerator('cache')
class CacheEndpointGenerator {

  @Route(':key')
  @PublicResource()
  async getCacheValue(req: Request, res: Express.Response): Promise<Response> {
    const value = await cache.valueForKey(req.params.key);
    if (value === undefined || value === null) {
      const data = {
        success: false,
        error: {
          id: 'NotFound',
          message: `No value found for key '${req.params.key}'`
        }
      };
      return { status: 404, data };
    }
    const data = {
      success: true,
      value
    };
    return { data };
  }

  @Route('add', 'PUT')
  @HttpBody(new SetCacheValueBodyValidator(), true)
  @PublicResource()
  async addCacheValue(req: Request<Record<string, never>, SetCacheValueSchema>, res: Express.Response): Promise<Response> {
    const body = req.jsonBody!;
    await cache.setValueForKey(body.value, body.key, body.ttl);
    const data = {
      success: true,
      message: `Set value for key '${body.key}'`
    };
    return { data };
  }
}

/// Quotes Methods ///
interface AddQuoteSchema extends RequestInputSchema {
  readonly content: string;
  readonly author: string;
  readonly date: string;
}

class AddQuoteSchemaValidator implements HttpBodyValidator<AddQuoteSchema> {
  isValid(body: AddQuoteSchema): boolean {
    const regex = /^[a-zA-Z0-9?.;,! ]+$/;
    return body.author !== undefined
      && body.content !== undefined
      && body.date !== undefined
      && regex.test(body.author)
      && regex.test(body.content)
      && body.date.length > 0;
  }
}

interface DeleteQuoteSchema extends RequestInputSchema {
  readonly quoteId: string;
}

interface SearchQuoteSchema extends RequestInputSchema {
  readonly searchTerm: string;
  readonly author?: string;
  readonly sortKey?: string;
  readonly ascendingSort?: boolean
};

class QuoteSearchTermQueryParameterValidator implements UrlQueryParameterValidator {
  isValid(name: string, value: string): boolean {
    const regex = /^[a-zA-Z0-9 ]+$/;
    return regex.test(value);
  }
}

class QuoteAuthorQueryParameterValidator implements UrlQueryParameterValidator {
  isValid(name: string, value: string): boolean {
    const regex = /^[a-zA-Z0-9 ]+$/;
    return regex.test(value);
  }
}

class QuoteSortKeyQueryParameterValidator implements UrlQueryParameterValidator {
  isValid(name: string, value: string): boolean {
    return ['content', 'date', 'author'].includes(value);
  }
}

class BooleanQueryParameterValidator implements UrlQueryParameterValidator {
  isValid(name: string, value: string): boolean {
    const lowercased = value.toLowerCase();
    return lowercased === 'true' || lowercased === 'false'
      || lowercased === '1' || lowercased === '0';
  }
}

class BooleanQueryParameterProcessor implements UrlQueryParameterProcessor<boolean> {
  process(name: string, value: string): [string, boolean] {
    const lowercased = value.toLowerCase();
    return [name, lowercased === 'true' || lowercased === '1' ? true : false];
  }
}

const passthroughProcessor = new UrlQueryParameterPassthroughProcessor();

@EndpointGenerator('quotes')
class QuotesEndpointGenerator extends BaseEndpointGenerator {

  constructor(private readonly dataManager: TestDataManager) {
    super();
  }

  @Route(':id')
  @PublicResource()
  @AuthRequired()
  async getQuote(req: Request): Promise<Response> {
    const quote = await this.dataManager.getQuoteWithId(req.params.id);

    if (quote) {
      const data = { success: true, quote };
      return { data };
    } else {
      const data = {
        success: false,
        error: {
          id: 'NotFound',
          message: `Failed to find quote with id: ${req.params.id}`
        }
      };
      return { status: 404, data };
    }
  }

  @Route('add', 'PUT')
  @HttpBody(new AddQuoteSchemaValidator(), true)
  @PublicResource()
  async addQuote(req: Request<Record<string, never>, AddQuoteSchema>): Promise<Response> {
    const addQuote = req.jsonBody!;
    const quote = this.dataManager.addQuote(addQuote.content, addQuote.author, addQuote.date);
    const data = {
      success: true,
      quote
    };
    return { data };
  }

  @Route('delete', 'DELETE')
  @PublicResource()
  @AuthRequired()
  async deleteQuote(req: Request<Record<string, never>, DeleteQuoteSchema>): Promise<Response> {
    const { quoteId } = req.jsonBody!;
    try {
      this.dataManager.deleteQuote(quoteId);
      const data = {
        success: true,
        message: `Successfully deleted quote with ID ${quoteId}`
      }
      return { data };
    } catch (error) {
      const message = (error as Error).message;
      const data = {
        success: false,
        error: {
          id: 'NotFound',
          message,
        }
      };
      return { status: 404, data };
    }
  }

  @Route('search', 'GET', 0)
  @QueryParameters([
    new UrlQueryParameter(
      'searchTerm',
      new QuoteSearchTermQueryParameterValidator(),
      passthroughProcessor,
      true /// required
    ),
    new UrlQueryParameter(
      'author',
      new QuoteAuthorQueryParameterValidator(),
      passthroughProcessor
    ),
    new UrlQueryParameter(
      'sortKey',
      new QuoteSortKeyQueryParameterValidator(),
      passthroughProcessor
    ),
    new UrlQueryParameter(
      'ascendingSort',
      new BooleanQueryParameterValidator(),
      new BooleanQueryParameterProcessor()
    )
  ])
  @PublicResource()
  async search(req: Request<SearchQuoteSchema>): Promise<Response> {
    const queryParams = req.queryParameters!
    const quotes = this.dataManager.searchQuotes(
      queryParams.searchTerm,
      queryParams.author,
      queryParams.sortKey,
      queryParams.ascendingSort ?? true
    );
    const data = {
      success: true,
      quotes
    };
    return { data };
  }

  @OwnerEvaluator()
  async owns(req: Request<Record<string, never>, DeleteQuoteSchema>): Promise<boolean> {
    if (typeof req.jsonBody !== 'object' || req.jsonBody === null) {
      /// This method is only applicable to quote deletion requests
      return false;
    }

    const { quoteId } = req.jsonBody!;
    const quote = await this.dataManager.getQuoteWithId(quoteId);
    const token = getAuthToken(req);
    if (token) {
      const claim = this.dataManager.verifyToken(token) as { username: string };
      return claim.username === quote?.ownerUserId;
    }
    return true;
  }
}

/// User Auth Methods ///
interface UserLoginSchema extends RequestInputSchema {
  readonly username: string;
  readonly password: string;
}

const loginMethod = {
  method: 'login',
  httpMethod: 'POST',
  jsonBodyRequired: true,
  characteristics: new Set([MethodCharacteristic.PublicUnownedData]),
  requestHandler: (req, res) => {
    const { username, password } = req.jsonBody!;
    const token = dataManager.login(username, password);
    const data = token !== undefined ?{
      success: true,
      authToken: token,
    } : {
      success: false,
      error: {
        id: 'Unauthorized',
        message: 'Invalid username or password.'
      }
    };
    return {
      status: token !== undefined ? 200 : 403,
      data
    };
  }
} as EndpointMethod<Record<string, never>, UserLoginSchema>;

//// END OF Methods and Schema Definitions ////

class TestAccessLevelEvaluator extends AccessLevelEvaluator {

  tokenPayload(token: string): string | jwt.JwtPayload | undefined {
    return dataManager.verifyToken(token);
  }

  protected isAuthenticatedRequestor<
    QuerySchema extends RequestInputSchema,
    BodySchema extends RequestInputSchema
  >(
    req: Request<QuerySchema, BodySchema>
  ): Promise<boolean> | boolean {
    const token = getAuthToken(req);
    if (token) {
      const claim = dataManager.verifyToken(token);
      return claim !== undefined;
    }
    return false;
  }
}

class ApixMetricManager implements MetricManager {
  public emit(metricName: string, value?: number, tags?: MetricTags) {
    console.log
      (`Emitting ${metricName} => ${value} with tags: ${JSON.stringify(tags ?? {})}`);
  }
}

const config = new ApiXConfig();

const manager = new AppManager(
  new TestAccessLevelEvaluator(),
  dataManager,
  config,
  cache,
  console
);

manager.setMetricManager(new ApixMetricManager(), {
  namePrefix: 'ApixInteg:',
  tags: {
    type: 'apixIntegTest'
  }
});

manager.registerAppMethod(loginMethod);

manager.registerEndpointGenerator(new CacheEndpointGenerator());

manager.registerEndpointGenerator(new QuotesEndpointGenerator(dataManager));

/// Run the server
manager.start();
