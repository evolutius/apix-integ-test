import {
  ApiXManager,
  ApiXMethod,
  ApiXMethodCharacteristic,
  ApiXDataManager,
  ApiXAccessLevelEvaluator,
  ApiXRedisStore,
  ApiXConfig,
  ApiXRequestInputSchema,
  ApiXCacheValue,
  ApiXHttpBodyValidator,
  ApiXUrlQueryParameterValidator,
  ApiXUrlQueryParameterProcessor,
  ApiXUrlQueryParameterPassthroughProcessor,
  ApiXUrlQueryParameter,
  ApiXHttpHeaders,
  ApiXRequest
} from '@evlt/apix';
import { Request } from 'express';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

dotenv.config();

const getAuthToken = <
  QuerySchema extends ApiXRequestInputSchema,
  BodySchema extends ApiXRequestInputSchema
>(req: ApiXRequest<QuerySchema, BodySchema>): string | undefined => {
  return req.header(ApiXHttpHeaders.AuthToken)?.split(' ')[1];
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

class DataManager implements ApiXDataManager {
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

const dataManager = new DataManager();

//// END OF Data Configuration ////

const cache = new ApiXRedisStore();

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
const getCacheValueMethod: ApiXMethod = {
  entity: 'cache',
  method: ':key',
  characteristics: new Set([ApiXMethodCharacteristic.PublicUnownedData]),
  requestHandler: async (req, res) => {
    const value = await cache.valueForKey(req.params.key);
    const data = {
      success: value !== null && value !== undefined,
      value
    };
    return { data };
  }
};

interface SetCacheValueSchema extends ApiXRequestInputSchema {
  readonly key: string;
  readonly value: ApiXCacheValue;
  readonly ttl?: number;
}

class SetCacheValueBodyValidator implements ApiXHttpBodyValidator<SetCacheValueSchema> {
  isValid(body: SetCacheValueSchema): boolean {
    return body.key !== undefined && body.key !== null
      && body.value !== undefined && body.value !== null;
  }
}

const setCacheValueMethod = {
  entity: 'cache',
  method: 'add',
  characteristics: new Set([ApiXMethodCharacteristic.PublicUnownedData]),
  jsonBodyRequired: true,
  jsonBodyValidator: new SetCacheValueBodyValidator(),
  httpMethod: 'PUT',
  requestHandler: async (req, res) => {
    const body = req.jsonBody!;
    await cache.setValueForKey(body.value, body.key, body.ttl);
    const data = {
      success: true,
      message: `Set value for key '${body.key}'`
    };
    return { data };
  }
} as ApiXMethod<Record<string, never>, SetCacheValueSchema>;

/// Quotes Methods ///
const getQuoteMethod: ApiXMethod = {
  entity: 'quotes',
  method: ':id',
  characteristics: new Set([ApiXMethodCharacteristic.PublicOwnedData]),
  requestHandler: async (req, res) => {
    const quote = await dataManager.getQuoteWithId(req.params.id);

    if (quote) {
      const data = { success: true, quote };
      return { data };
    } else {
      const data = {
        success: false,
        message: `Failed to find quote with id: ${req.params.id}`
      };
      return { status: 404, data };
    }
  },
  requestorOwnsResource: () => false  /// no consequence
};

interface AddQuoteSchema extends ApiXRequestInputSchema {
  readonly content: string;
  readonly author: string;
  readonly date: string;
}

class AddQuoteSchemaValidator implements ApiXHttpBodyValidator<AddQuoteSchema> {
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

const addQuoteMethod = {
  entity: 'quotes',
  method: 'add',
  httpMethod: 'PUT',
  characteristics: new Set([ApiXMethodCharacteristic.PublicOwnedData]),
  jsonBodyRequired: true,
  jsonBodyValidator: new AddQuoteSchemaValidator(),
  requestHandler: (req, res) => {
    const addQuote = req.jsonBody!;
    const quote = dataManager.addQuote(addQuote.content, addQuote.author, addQuote.date);
    const data = {
      success: true,
      quote
    };
    return { data };
  },
  requestorOwnsResource: () => true  // as long as requestor is authenticated, they will own the quote they create
} as ApiXMethod<Record<string, never>, AddQuoteSchema>;

interface DeleteQuoteSchema extends ApiXRequestInputSchema {
  readonly quoteId: string;
}

const deleteQuoteMethod = {
  entity: 'quotes',
  method: 'delete',
  httpMethod: 'DELETE',
  characteristics: new Set([ApiXMethodCharacteristic.PublicOwnedData]),
  jsonBodyRequired: true,
  requestHandler: (req, res) => {
    const { quoteId } = req.jsonBody!;
    try {
      dataManager.deleteQuote(quoteId);
      const data = {
        success: true,
        message: `Successfully deleted quote with ID ${quoteId}`
      }
      return { data };
    } catch (error) {
      const message = (error as Error).message;
      const data = {
        success: false,
        message
      };
      return { data };
    }
  },
  requestorOwnsResource: async (req) => {
    const { quoteId } = req.jsonBody!;
    const quote = await dataManager.getQuoteWithId(quoteId);
    const token = getAuthToken(req);
    if (token) {
      const claim = dataManager.verifyToken(token) as { username: string };
      return claim.username === quote?.ownerUserId;
    }
    return true;
  }
} as ApiXMethod<Record<string, never>, DeleteQuoteSchema>;

interface SearchQuoteSchema extends ApiXRequestInputSchema {
  readonly searchTerm: string;
  readonly author?: string;
  readonly sortKey?: string;
  readonly ascendingSort?: boolean
};

class QuoteSearchTermQueryParameterValidator implements ApiXUrlQueryParameterValidator {
  isValid(name: string, value: string): boolean {
    const regex = /^[a-zA-Z0-9 ]+$/;
    return regex.test(value);
  }
}

class QuoteAuthorQueryParameterValidator implements ApiXUrlQueryParameterValidator {
  isValid(name: string, value: string): boolean {
    const regex = /^[a-zA-Z0-9 ]+$/;
    return regex.test(value);
  }
}

class QuoteSortKeyQueryParameterValidator implements ApiXUrlQueryParameterValidator {
  isValid(name: string, value: string): boolean {
    return ['content', 'date', 'author'].includes(value);
  }
}

class BooleanQueryParameterValidator implements ApiXUrlQueryParameterValidator {
  isValid(name: string, value: string): boolean {
    const lowercased = value.toLowerCase();
    return lowercased === 'true' || lowercased === 'false'
      || lowercased === '1' || lowercased === '0';
  }
}

class BooleanQueryParameterProcessor implements ApiXUrlQueryParameterProcessor<boolean> {
  process(name: string, value: string): [string, boolean] {
    const lowercased = value.toLowerCase();
    return [name, lowercased === 'true' || lowercased === '1' ? true : false];
  }
}

const passthroughProcessor = new ApiXUrlQueryParameterPassthroughProcessor();

const searchQuoteMethod: ApiXMethod<SearchQuoteSchema> = {
  entity: 'quotes',
  method: 'search',
  characteristics: new Set([ApiXMethodCharacteristic.PublicUnownedData]),
  queryParameters: [
    new ApiXUrlQueryParameter(
      'searchTerm',
      new QuoteSearchTermQueryParameterValidator(),
      passthroughProcessor,
      true /// required
    ),
    new ApiXUrlQueryParameter(
      'author',
      new QuoteAuthorQueryParameterValidator(),
      passthroughProcessor
    ),
    new ApiXUrlQueryParameter(
      'sortKey',
      new QuoteSortKeyQueryParameterValidator(),
      passthroughProcessor
    ),
    new ApiXUrlQueryParameter(
      'ascendingSort',
      new BooleanQueryParameterValidator(),
      new BooleanQueryParameterProcessor()
    )
  ],
  requestHandler: async (req, res) => {
    const queryParams = req.queryParameters!
    const quotes = dataManager.searchQuotes(
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
};

/// User Auth Methods ///
interface UserLoginSchema extends ApiXRequestInputSchema {
  readonly username: string;
  readonly password: string;
}

const loginMethod = {
  method: 'login',
  httpMethod: 'POST',
  jsonBodyRequired: true,
  characteristics: new Set([ApiXMethodCharacteristic.PublicUnownedData]),
  requestHandler: (req, res) => {
    const { username, password } = req.jsonBody!;
    const token = dataManager.login(username, password);
    const data = {
      success: token !== undefined,
      authToken: token,
      message: token !== undefined ? undefined : 'Invalid username or password.'
    };
    return {
      status: token !== undefined ? 200 : 403,
      data
    };
  }
} as ApiXMethod<Record<string, never>, UserLoginSchema>;

//// END OF Methods and Schema Definitions ////

class AccessLevelEvaluator extends ApiXAccessLevelEvaluator {

  tokenPayload(token: string): string | jwt.JwtPayload | undefined {
    return dataManager.verifyToken(token);
  }

  protected isAuthenticatedRequestor<
    QuerySchema extends ApiXRequestInputSchema,
    BodySchema extends ApiXRequestInputSchema
  >(
    req: ApiXRequest<QuerySchema, BodySchema>
  ): Promise<boolean> | boolean {
    const token = getAuthToken(req);
    if (token) {
      const claim = dataManager.verifyToken(token);
      return claim !== undefined;
    }
    return false;
  }
}

const config = new ApiXConfig();

const manager = new ApiXManager(
  new AccessLevelEvaluator(),
  dataManager,
  config,
  cache,
  console
);

manager.registerAppMethod(loginMethod);

manager.registerAppMethod(getCacheValueMethod);
manager.registerAppMethod(setCacheValueMethod);

manager.registerAppMethod(addQuoteMethod);
manager.registerAppMethod(deleteQuoteMethod);
manager.registerAppMethod(searchQuoteMethod);
manager.registerAppMethod(getQuoteMethod);

/// Run the server
manager.start();
