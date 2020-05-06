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
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      if (res.statusCode !== 200 && res.statusCode !== 302) {
        return reject(new Error(`Status code: ${res.statusCode}`));
      }
      const data = [];
      res.on('data', chunk => {
        data.push(chunk);
      });
      res.on('end', () => resolve({
        headers: res.headers,
        body: Buffer.concat(data).toString()
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
      listItem: `div.grid-display.row > div.grid-display > div[data-tile-type="${type}"]> div#single-user-holding`,
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

(async () => {
  try {
    if (!process.env.USERNAME || !process.env.PASSWORD) {
      throw new Error('You must supply a username and password in the .env file supplied');
    }
    const username = escape(process.env.USERNAME);
    const password = escape(process.env.PASSWORD);

    const sessionCookieOptions = {
      hostname,
      port: 443,
      method: 'GET',
      path: '/',
      headers: {
        'User-Agent': userAgent
      }
    };
    request(sessionCookieOptions)
      .then(cookieData => {
        const sessionCookie = cookieData.headers['set-cookie'].find(cookie => cookie.indexOf('ASP.NET_SessionId') > -1);
        const serverIdCookie = cookieData.headers['set-cookie'].find(cookie => cookie.indexOf('srv_id') > -1);
        const formData = `UserIdentifier=${username}&Password=${password}&ReturnUrl=&OneSignalGameId=`;
        const easyEquitiesCookieOptions = {
          hostname,
          port: 443,
          method: 'POST',
          path: '/Account/SignIn',
          headers: {
            'Cookie': [sessionCookie, serverIdCookie],
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': formData.length,
            'User-Agent': userAgent
          }
        };
        request(easyEquitiesCookieOptions, formData)
          .then(easyEquitiesCookieData => {
            const easyEquitiesCookie = easyEquitiesCookieData.headers['set-cookie'].find(cookie => cookie.indexOf('EasyEquities') > -1);
            const epochTime = Math.round(new Date().getTime() / 1000) - 1000;
            const accountOverviewOptions = {
              hostname,
              port: 443,
              method: 'GET',
              path: `/AccountOverview/GetHoldingsView?stockViewCategoryId=12&_=${epochTime}`,
              headers: {
                'Cookie': [sessionCookie, serverIdCookie, easyEquitiesCookie],
                'User-Agent': userAgent
              }
            };

            request(accountOverviewOptions)
              .then(holdingsData => {
                const valueData = getHoldingData('value', holdingsData.body);
                const shareData = getHoldingData('share', holdingsData.body)

                if (valueData.holdings.length > 0) {
                  const result = valueData.holdings.map(valueHolding => {
                    const shareHolding = shareData.holdings.find(share => share.name === valueHolding.name);
                    if (shareHolding) {
                      Object.assign(valueHolding, shareHolding);
                    }
                    return valueHolding;
                  });

                  const fileName = `${(new Date()).toISOString().slice(0, 19).replace(/:/g,'-')}`;
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
                  console.error('Nothing inside valueData');
                }
              })
              .catch(err => console.error(err.stack));
          })
          .catch(err => console.error(err));
      })
      .catch(err => console.error(err));
  } catch (err) {
    console.error(err);
  }
})();