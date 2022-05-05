"use strict";

const https = require("https");
const fs = require("fs");
const moment = require("moment");
const parser = require("json2csv").parse;
const { parse } = require("node-html-parser");
const { decode } = require("html-entities");

process.chdir(__dirname);

require("dotenv").config();
require("log-timestamp")(
  () => `[${moment().format("YYYY-MM-DD HH:mm:ss.SSS")}]`
);

const hostname = process.env.EEURL;
const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.132 Safari/537.36";
const username = encodeURI(process.env.EEUSERNAME);
const password = encodeURI(process.env.EEPASSWORD);
const dataDir = process.env.EEDATADIR;
const cookies = [];
const trustAccounts = [];

const getDefaultRequestOptions = (method = "GET", path = "/", cookies) => {
  const options = {
    hostname,
    port: 443,
    method,
    path,
    headers: {
      "User-Agent": userAgent,
    },
  };
  if (cookies && Array.isArray(cookies)) {
    Object.assign(options.headers, {
      Cookie: cookies,
    });
  }
  return options;
};

const request = async (options, postData) => {
  if (!options) throw new Error("Options must be supplied");
  const postHeaders = {};
  if (postData) {
    try {
      JSON.parse(postData);
      postHeaders["Content-Type"] = "application/json; charset=UTF-8";
    } catch (e) {
      postHeaders["Content-Type"] =
        "application/x-www-form-urlencoded; charset=UTF-8";
    }
    postHeaders["Content-Length"] = postData.length;
    Object.assign(options.headers, postHeaders);
  }
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      if (res.statusCode !== 200 && res.statusCode !== 302) {
        reject(new Error(`Status code: ${res.statusCode}`));
      }
      const data = [];
      res
        .on("data", (chunk) => {
          data.push(chunk);
        })
        .on("end", () =>
          resolve({
            body: Buffer.concat(data).toString(),
            headers: res.headers,
            statusCode: res.statusCode,
          })
        );
    });
    req.on("error", reject);
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
};

const getCookie = (response, cookieName) => {
  if (response && response.headers)
    return response.headers["set-cookie"].find(
      (cookie) => cookie.indexOf(cookieName) > -1
    );
  throw new Error(`Unable to find a cookie named '${cookieName}'`);
};

const getEpochTime = () => Math.round(new Date().getTime() / 1000) - 1000;

(async () => {
  const loginFormData = `UserIdentifier=${username}&Password=${password}&ReturnUrl=&OneSignalGameId=`;
  const signInResponse = await request(
    getDefaultRequestOptions("POST", "/Account/SignIn"),
    loginFormData
  );
  cookies.push(
    ...[
      getCookie(signInResponse, "ASP.NET_SessionId"),
      getCookie(signInResponse, "srv_id"),
      getCookie(signInResponse, "EasyEquities"),
    ]
  );

  const accountOverviewResponse = await request(
    getDefaultRequestOptions("GET", "/AccountOverview", cookies)
  );
  const parsedAccOverview = parse(accountOverviewResponse.body);
  const accountTabs = parsedAccOverview.querySelectorAll("#selector-tab");
  Array.from(accountTabs).forEach((tab) => {
    trustAccounts.push({
      id: tab.attributes["data-id"],
      currencyId: tab.attributes["data-tradingcurrencyid"],
    });
  });

  for (const account of trustAccounts) {
    const canUseSelectedAccount = await request(
      getDefaultRequestOptions(
        "GET",
        `/Menu/CanUseSelectedAccount?tradingCurrencyId=${
          account.currencyId
        }&_=${getEpochTime()}`,
        cookies
      )
    );

    if (canUseSelectedAccount.statusCode !== 200) return;
    const canUse = JSON.parse(canUseSelectedAccount.body).CanUse;
    if (canUse) {
      const trustAccountPostData = `trustAccountId=${account.id}`;
      await request(
        getDefaultRequestOptions("POST", "/Menu/UpdateCurrency", cookies),
        trustAccountPostData
      );
    } else {
      console.error(`Can't use account '${account.id}', skipping...`);
      continue;
    }

    const holdingsView = await request(
      getDefaultRequestOptions(
        "GET",
        `/AccountOverview/GetHoldingsView?stockViewCategoryId=12&_=${getEpochTime()}`,
        cookies
      )
    );

    const parsedHoldingsView = parse(holdingsView.body);
    const holdingsCells = parsedHoldingsView.querySelectorAll(
      "div.holding-table-body > div > div > div.holding-inner-container"
    );

    if (holdingsCells.length > 0) {
      const holdings = [];
      for (const holding of holdingsCells) {
        const name = decode(holding
          .querySelector(".equity-image-as-text")
          .innerText.trim());
        const purchaseValue = holding
          .querySelector(".purchase-value-cell")
          .innerText.trim();
        const currentValue = holding
          .querySelector(".current-value-cell")
          .innerText.trim();
        const currentPrice = holding
          .querySelector(".current-price-cell")
          .innerText.trim();
        const pnlValues = holding
          .querySelector(".pnl-cell")
          .innerText.trim()
          .split("(");
        let pnlValue;
        let pnlPercent;
        if (pnlValues.length > 1) {
          pnlValue = pnlValues[0].replace(/[+]/gi, "").trim();
          pnlPercent = pnlValues[1].replace(/[+)]/gi, "").trim();
        } else {
          const tmpPV = Number(purchaseValue.replace(/[()\sR$+-]/gi, ""));
          const tmpCV = Number(currentValue.replace(/[()\sR$+-]/gi, ""));
          pnlValue = (tmpCV - tmpPV).toFixed(2);
          pnlPercent = pnlValues[0].replace(/[+)]/gi, "").trim();
        }

        const moreDetailUrl =
          holding.querySelector(".detail-dropdown")?.attributes[
            "data-detailViewUrl"
          ];

        let shares, fsrs, avgPurchasePrice;
        if (moreDetailUrl && moreDetailUrl.indexOf("bundleId") === -1) {
          const extraDetails = await request(
            getDefaultRequestOptions("GET", moreDetailUrl, cookies)
          );
          const parsedExtraDetails = parse(extraDetails.body);

          shares = parsedExtraDetails
            .querySelector(
              "div.content-box > div:nth-child(2) > div:nth-child(2)"
            )
            .innerText.trim();
          fsrs = parsedExtraDetails.querySelector(
            "div.content-box > div:nth-child(3) > div:nth-child(2)"
          )
            ? parsedExtraDetails
                .querySelector(
                  "div.content-box > div:nth-child(3) > div:nth-child(2)"
                )
                .innerText.trim()
            : null;
          avgPurchasePrice = parsedExtraDetails.querySelector(
            "div.content-box > div:nth-child(5) > div:nth-child(2)"
          )
            ? parsedExtraDetails
                .querySelector(
                  "div.content-box > div:nth-child(5) > div:nth-child(2)"
                )
                .innerText.trim()
            : null;
        }
        holdings.push({
          name,
          shares,
          fsrs,
          purchaseValue,
          currentValue,
          pnlValue,
          avgPurchasePrice,
          delayedPrice: currentPrice,
          pnlPercent,
        });
      }

      if (!fs.existsSync(`${dataDir}/${account.id}`)) {
        fs.mkdirSync(`${dataDir}/${account.id}`, {recursive: true});
        fs.mkdirSync(`${dataDir}/${account.id}/csv`);
        fs.mkdirSync(`${dataDir}/${account.id}/json`);
      }

      const fileDateTime = moment().format('YYYYMMDDTHHmmss');
      const fileName = `${account.id}-${fileDateTime}`;
      fs.writeFileSync(`${dataDir}/${account.id}/json/${fileName}.json`, JSON.stringify(holdings), {
        flag: 'w'
      });
      const csv = parser(holdings, {
        fields: ['name', 'shares', 'fsrs', 'purchaseValue', 'currentValue', 'pnlValue', 'avgPurchasePrice', 'delayedPrice', 'pnlPercent'],
      });
      fs.writeFileSync(`${dataDir}/${account.id}/csv/${fileName}.csv`, csv, {
        flag: 'w'
      });
      console.log(`Scrapes saved to file(s) '${fileName}.json' and '${fileName}.csv'`);
    } else {
      console.error(`No holdings found for account ${account.id}`);
    }
  }
})();
