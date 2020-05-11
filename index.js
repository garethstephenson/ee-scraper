const https = require('https');
const scrapeIt = require('scrape-it');
const fs = require('fs');
const {
  parse
} = require('json2csv');
require('dotenv').config();

const hostname = 'platform.easyequities.co.za';
const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.132 Safari/537.36';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = async (options, postData) => {
  if (!options) throw new Error('Options must be supplied');
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      if (res.statusCode !== 200 && res.statusCode !== 302) {
        return reject(new Error(`Status code: ${res.statusCode}`));
      }
      const data = [];
      res.on('data', chunk => {
        data.push(chunk);
      }).on('end', () => resolve({
        body: Buffer.concat(data).toString(),
        headers: res.headers,
        statusCode: res.statusCode
      }));
    });
    req.on('error', reject);
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
};

function getHoldingData(type, data) {
  const scrapeItOptions = {
    holdings: {
      listItem: `div.grid-display.row > div.grid-display > div[data-tile-type='${type}']> div#single-user-holding`,
      data: {
        name: {
          selector: 'div.stock-name'
        },
        shares: {
          selector: 'td.left-column'
        },
        fsrs: {
          selector: 'td.right-column'
        },
      }
    }
  };

  let className = '';
  const props = [];

  switch (type) {
    case 'value':
      className = 'text-right';
      props.push({
        name: 'purchaseValue',
        index: 2
      });
      props.push({
        name: 'currentValue',
        index: 3
      });
      props.push({
        name: 'pnlValue',
        index: 4
      });
      break;
    case 'share':
      className = 'right-value-column';
      props.push({
        name: 'avgPurchasePrice',
        index: 2
      });
      props.push({
        name: 'delayedPrice',
        index: 3
      });
      props.push({
        name: 'pnlPercent',
        index: 4
      });
      break;
  }

  const scrapeItData = scrapeItOptions.holdings.data;
  for (const prop of props) {
    scrapeItData[prop.name] = {
      selector: `div > div > div > div:nth-child(2) > div:nth-child(${prop.index}) > div.${className}`
    };
  }
  const result = scrapeIt.scrapeHTML(data, scrapeItOptions);
  return result;
}

function getTrustAccounts(data) {
  const scrapeItOptions = {
    accounts: {
      listItem: '#trust-account-content',
      data: {
        id: {
          selector: 'div',
          attr: 'data-id'
        },
        currencyId: {
          selector: 'div',
          attr: 'data-tradingcurrencyid'
        }
      }
    }
  };
  return scrapeIt.scrapeHTML(data, scrapeItOptions);
}

function getEpochTime() {
  return Math.round(new Date().getTime() / 1000) - 1000;
}

function getDefaultRequestOptions(method = 'GET', path = '/', headers) {
  const options = {
    hostname,
    port: 443,
    method,
    path,
    headers: {
      'User-Agent': userAgent
    }
  };
  if (headers) {
    Object.assign(options.headers, headers);
  }
  return options;
}

function getCookie(response, cookieName) {
  if (response && response.headers)
    return response.headers['set-cookie'].find(cookie => cookie.indexOf(cookieName) > -1);
  throw new Error(`Unable to find a cookie named '${cookieName}'`);
}

(async () => {
  try {
    if (!process.env.USERNAME || !process.env.PASSWORD) {
      throw new Error('You must supply a username and password in the .env file supplied');
    }
    const username = escape(process.env.USERNAME);
    const password = escape(process.env.PASSWORD);

    const sessionCookieOptions = getDefaultRequestOptions();
    request(sessionCookieOptions)
      .then(sessionCookieResponse => {
        const sessionCookie = getCookie(sessionCookieResponse, 'ASP.NET_SessionId');
        const serverIdCookie = getCookie(sessionCookieResponse, 'srv_id');
        const loginFormData = `UserIdentifier=${username}&Password=${password}&ReturnUrl=&OneSignalGameId=`;
        const easyEquitiesCookieOptions = getDefaultRequestOptions('POST', '/Account/SignIn', {
          'Cookie': [sessionCookie, serverIdCookie],
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': loginFormData.length
        });

        request(easyEquitiesCookieOptions, loginFormData)
          .then(easyEquitiesCookieResponse => {
            const easyEquitiesCookie = getCookie(easyEquitiesCookieResponse, 'EasyEquities');
            const accountOverviewOptions = getDefaultRequestOptions('GET', '/AccountOverview', {
              'Cookie': [sessionCookie, serverIdCookie, easyEquitiesCookie]
            });

            // Get all the accounts listed in this profile
            // -------------------------------------------
            request(accountOverviewOptions)
              .then(accountOverviewResponse => {
                const trustAccounts = getTrustAccounts(accountOverviewResponse.body);
                trustAccounts.accounts.forEach(trustAccount => {

                  const canUseAccountOptions = getDefaultRequestOptions('GET',
                    `/Menu/CanUseSelectedAccount?tradingCurrencyId=${trustAccount.currencyId}&_=${getEpochTime()}`, {
                      'Cookie': [sessionCookie, serverIdCookie, easyEquitiesCookie]
                    });

                  // See if we can use this account
                  // ------------------------------
                  request(canUseAccountOptions)
                    .then(canUseAccountResponse => {
                      if (JSON.parse(canUseAccountResponse.body).CanUse) {

                        const trustAccountPostData = `trustAccountId=${trustAccount.id}`;
                        const updateCurrencyOptions = getDefaultRequestOptions('POST', '/Menu/UpdateCurrency', {
                          'Cookie': [sessionCookie, serverIdCookie, easyEquitiesCookie],
                          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                          'Content-Length': trustAccountPostData.length,
                        });

                        // Change the currency for the selected account
                        // --------------------------------------------
                        request(updateCurrencyOptions, trustAccountPostData)
                          .then(updateCurrencyResponse => {
                            const trustAccountValuationOptions = getDefaultRequestOptions('GET',
                              `/AccountOverview/GetTrustAccountValuations?_=${getEpochTime()}`, {
                                'Cookie': [sessionCookie, serverIdCookie, easyEquitiesCookie],
                              });

                            request(trustAccountValuationOptions)
                              .then(trustAccountValuationResponse => {
                                const accountOverviewHoldingsOptions = getDefaultRequestOptions('GET',
                                  `/AccountOverview/GetHoldingsView?stockViewCategoryId=12&_=${getEpochTime()}`, {
                                    'Cookie': [sessionCookie, serverIdCookie, easyEquitiesCookie]
                                  });

                                // This gets the holdings list in various view form factors
                                // --------------------------------------------------------
                                request(accountOverviewHoldingsOptions)
                                  .then(holdingsResponse => {
                                    const valueData = getHoldingData('value', holdingsResponse.body);
                                    const shareData = getHoldingData('share', holdingsResponse.body)

                                    if (valueData.holdings.length > 0) {
                                      const result = valueData.holdings.map(valueHolding => {
                                        const shareHolding = shareData.holdings.find(share => share.name === valueHolding.name);
                                        if (shareHolding) {
                                          Object.assign(valueHolding, shareHolding);
                                        }
                                        return valueHolding;
                                      });

                                      const fileName = `${trustAccount.id}-${(new Date()).toISOString().slice(0, 19).replace(/:/g,'-')}`;
                                      fs.writeFileSync(`./data/${fileName}.json`, JSON.stringify(result), {
                                        flag: 'w'
                                      });
                                      const csv = parse(result, {
                                        fields: ['name', 'shares', 'fsrs', 'purchaseValue', 'currentValue', 'pnlValue', 'avgPurchasePrice', 'delayedPrice', 'pnlPercent'],
                                      });
                                      fs.writeFileSync(`./data/${fileName}.csv`, csv, {
                                        flag: 'w'
                                      });
                                      console.log(`Scrapes saved to file(s) '${fileName}.json' and '${fileName}.csv'`);
                                    } else {
                                      console.error(`No holdings found for account ${trustAccount.id}`);
                                    }
                                  });
                              });
                          });
                      }
                    });
                });
              });
          });
      });
  } catch (err) {
    console.error(err);
  }
})();