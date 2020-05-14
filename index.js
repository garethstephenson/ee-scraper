'use strict';

const https = require('https');
const scrapeIt = require('scrape-it');
const fs = require('fs');
const moment = require('moment');
const { parse } = require('json2csv');

process.chdir(__dirname);

require('dotenv').config();

const hostname = 'platform.easyequities.co.za';
const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.132 Safari/537.36';
const username = escape(process.env.EEUSERNAME);
const password = escape(process.env.EEPASSWORD);
const dataDir = process.env.EEDATADIR;
const cookies = [];
const trustAccounts = [];

const request = async (options, postData) => {
  if (!options) throw new Error('Options must be supplied');
  const postHeaders = {};
  if (postData) {
    try {
      JSON.parse(postData);
      postHeaders['Content-Type'] = 'application/json; charset=UTF-8';
    } catch (e) {
      postHeaders['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    }
    postHeaders['Content-Length'] = postData.length;
    Object.assign(options.headers, postHeaders);
  }
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      if (res.statusCode !== 200 && res.statusCode !== 302) {
        reject(new Error(`Status code: ${res.statusCode}`));
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

const getDefaultRequestOptions = (method = 'GET', path = '/', cookies) => {
  const options = {
    hostname,
    port: 443,
    method,
    path,
    headers: {
      'User-Agent': userAgent
    }
  };
  if (cookies && Array.isArray(cookies)) {
    Object.assign(options.headers, {
      'Cookie': cookies
    });
  }
  return options;
};

const getCookie = (response, cookieName) => {
  if (response && response.headers)
    return response.headers['set-cookie'].find(cookie => cookie.indexOf(cookieName) > -1);
  throw new Error(`Unable to find a cookie named '${cookieName}'`);
};

const getTrustAccounts = (data) => {
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
};

const getHoldingData = (type, data) => {
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
        name: 'managedPurchaseValue',
        index: 1
      });
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

const getEpochTime = () => Math.round(new Date().getTime() / 1000) - 1000;

(async () => {

  const formData = `UserIdentifier=${username}&Password=${password}&ReturnUrl=&OneSignalGameId=`;
  request(getDefaultRequestOptions('POST', '/Account/SignIn'), formData)
    .then(response =>
      cookies.push(...[
        getCookie(response, 'ASP.NET_SessionId'),
        getCookie(response, 'srv_id'),
        getCookie(response, 'EasyEquities')
      ])
    )
    .then(async () => await request(getDefaultRequestOptions('GET', '/AccountOverview', cookies)))
    .then(async response => {
      trustAccounts.push(...getTrustAccounts(response.body).accounts);
      for (const account of trustAccounts) {
        await request(getDefaultRequestOptions(
            'GET',
            `/Menu/CanUseSelectedAccount?tradingCurrencyId=${account.currencyId}&_=${getEpochTime()}`,
            cookies))
          .then(async response => {
            const canUse = JSON.parse(response.body).CanUse;
            if (canUse) {
              const trustAccountPostData = `trustAccountId=${account.id}`;
              return await request(getDefaultRequestOptions('POST', '/Menu/UpdateCurrency', cookies), trustAccountPostData);
            } else {
              throw new Error(`Can't use account '${account.id}', skipping...`);
            }
          })
          .then(async () => await request(getDefaultRequestOptions(
            'GET',
            `/AccountOverview/GetHoldingsView?stockViewCategoryId=12&_=${getEpochTime()}`,
            cookies)))
          .then(response => {
            const valueData = getHoldingData('value', response.body);
            const shareData = getHoldingData('share', response.body);
            if (valueData.holdings.length > 0) {
              const result = valueData.holdings.map(valueHolding => {
                const shareHolding = shareData.holdings.find(share => share.name === valueHolding.name);
                if (shareHolding) {
                  // DIY shares
                  delete valueHolding.managedPurchaseValue;
                  Object.assign(valueHolding, shareHolding);
                } else {
                  // Managed shares
                  const pnlValue = valueHolding.currentValue;
                  const pnlPercent = valueHolding.pnlValue;
                  valueHolding.currentValue = valueHolding.purchaseValue;
                  valueHolding.purchaseValue = valueHolding.managedPurchaseValue;
                  valueHolding.pnlValue = pnlValue;
                  valueHolding.pnlPercent = pnlPercent;
                }
                return valueHolding;
              });

              if (!fs.existsSync(`${dataDir}/${account.id}`)) {
                fs.mkdirSync(`${dataDir}/${account.id}`);
                fs.mkdirSync(`${dataDir}/${account.id}/csv`);
                fs.mkdirSync(`${dataDir}/${account.id}/json`);
              }

              const fileDateTime = moment().format('YYYYMMDDTHHmmss');
              const fileName = `${account.id}-${fileDateTime}`;
              fs.writeFileSync(`${dataDir}/${account.id}/json/${fileName}.json`, JSON.stringify(result), {
                flag: 'w'
              });
              const csv = parse(result, {
                fields: ['name', 'shares', 'fsrs', 'purchaseValue', 'currentValue', 'pnlValue', 'avgPurchasePrice', 'delayedPrice', 'pnlPercent'],
              });
              fs.writeFileSync(`${dataDir}/${account.id}/csv/${fileName}.csv`, csv, {
                flag: 'w'
              });
              console.log(`Scrapes saved to file(s) '${fileName}.json' and '${fileName}.csv'`);
            } else {
              console.error(`No holdings found for account ${account.id}`);
            }
          })
          .catch(err => console.error(err));
      }
    });
})();