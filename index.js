const { promisify } = require("util");
const fs = require("fs");
const readdir = promisify(fs.readdir);
const readFile = promisify(fs.readFile);
const path = require("path");
const {
  countBy,
  flatten,
  get,
  identity,
  maxBy,
  memoize,
  pickBy,
  uniq,
  zipObject
} = require("lodash");

//==================================================================================================
//==================================================================================================

const DB_LOCATION = "/Users/ericbaer/Downloads/2017-07-01-tx-json";
const STATE = "tx";

// ID for Rep. Paul, Dennis
// https://openstates.org/tx/legislators/TXL000484/paul-dennis/
const REP_ID = "TXL000484";

// Threshold in which a bill is considered partisain vote
const PARTISAIN_THRESHOLD = 0.9;

//==================================================================================================
//==================================================================================================

const getBill = (session, chamber, bill) => {
  const rootPath = `${DB_LOCATION}/bills/${STATE}/${session}/${chamber}`;

  return readFile(path.join(rootPath, bill), { encoding: "utf8" }).then(
    JSON.parse
  );
};

const getAllBillsFromSession = (session, chamber) => {
  const filePath = `${DB_LOCATION}/bills/${STATE}/${session}/${chamber}`;

  return readdir(filePath).then(files => {
    const allBills = files.map(bill => getBill(session, chamber, bill));
    return Promise.all(allBills);
  });
};

const getLegislator = memoize(repId =>
  readFile(`${DB_LOCATION}/legislators/${repId}`, {
    encoding: "utf8"
  }).then(JSON.parse)
);

const isPartisainVote = (threshold, votes) =>
  Promise.resolve(votes)
    .then(votes => votes.map(vote => vote.leg_id))
    .then(votes => votes.filter(Boolean))
    .then(votes => Promise.all(votes.map(getLegislator)))
    .then(legislators => countBy(legislators, legislator => legislator.party))
    .then(voteCount => {
      const totalVotes = voteCount["Republican"] + voteCount["Democratic"];
      const isRepublicanLeaning =
        voteCount["Republican"] > voteCount["Democratic"];

      return isRepublicanLeaning
        ? voteCount["Republican"] / totalVotes >= threshold
        : voteCount["Democratic"] / totalVotes >= threshold;
    });

const isPartisainBill = (threshold, bill) => {
  // TODO: what does it mean to have multiple votes in one bill?
  const yesVotes = get(bill, "votes[0].yes_votes", []);
  const noVotes = get(bill, "votes[0].no_votes", []);

  return Promise.all([
    isPartisainVote(threshold, yesVotes),
    isPartisainVote(threshold, noVotes)
  ]).then(result => result[0] || result[1]);
};

const getPartisainBillsFromSession = (session, chamber, threshold) =>
  getAllBillsFromSession(session, chamber).then(bills => {
    const billIds = bills.map(bill => bill.bill_id);
    const billStatus = Promise.all(
      bills.map(bill => isPartisainBill(threshold, bill))
    );

    return billStatus
      .then(status => zipObject(billIds, status))
      .then(bills => pickBy(bills, isPartisain => isPartisain))
      .then(Object.keys);
  });

const getPartyPosition = (bill, party) => {
  const yesVotes = get(bill, "votes[0].yes_votes", []);
  const noVotes = get(bill, "votes[0].no_votes", []);

  const yes = Promise.resolve(yesVotes)
    .then(votes => votes.filter(vote => vote.leg_id))
    .then(votes => Promise.all(votes.map(vote => getLegislator(vote.leg_id))))
    .then(legislators => legislators.map(legislator => legislator.party))
    .then(partyAffiliations => countBy(partyAffiliations, identity));

  const no = Promise.resolve(noVotes)
    .then(votes => votes.filter(vote => vote.leg_id))
    .then(votes => Promise.all(votes.map(vote => getLegislator(vote.leg_id))))
    .then(legislators => legislators.map(legislator => legislator.party))
    .then(partyAffiliations => countBy(partyAffiliations, identity));

  return Promise.all([yes, no]).then(
    result => (result[0][party] > result[0][party] ? "yes" : "no")
  );
};

//==================================================================================================

getLegislator(REP_ID)
  // Get the full bill details for all partisain bills voted on during sessions served by the given
  // representative
  .then(rep => {
    const sessionsServed = uniq(rep.roles.map(role => role.term));
    const chamber = rep.chamber;

    const partisainBillsDuringSessionServed = sessionsServed.map(session => {
      return getPartisainBillsFromSession(
        session,
        chamber,
        PARTISAIN_THRESHOLD
      ).then(bills =>
        Promise.all(bills.map(bill => getBill(session, chamber, bill)))
      );
    });

    return Promise.all(partisainBillsDuringSessionServed).then(flatten);
  })
  // Filter out all bills that the given representative didn't cast a vote on
  .then(bills => {
    return bills.filter(bill => {
      const allVotes = [].concat(
        get(bill, "votes[0].yes_votes", []),
        get(bill, "votes[0].no_votes", [])
      );

      return allVotes.reduce(
        (memo, vote) => memo || vote.leg_id === REP_ID,
        false
      );
    });
  })
  // Generate an object where the keys are a the billId of a partisain bill that the representative
  // voted on and the value is whether or not they voted the same way as their party.
  .then(bills => {
    const didContradictPartyPosition = Promise.all(
      bills.map(bill => {
        const yesVotes = get(bill, "votes[0].yes_votes", []);
        const noVotes = get(bill, "votes[0].no_votes", []);
        const partyPosition = getPartyPosition(bill, "Republican");

        return partyPosition.then(position => {
          const partyVotes = position === "yes" ? yesVotes : noVotes;
          return partyVotes.reduce(
            (memo, vote) => memo || vote.leg_id === REP_ID,
            false
          );
        });
      })
    );

    return didContradictPartyPosition.then(contradictions =>
      zipObject(bills.map(bill => bill.bill_id), contradictions)
    );
  })
  .then(result => {
    /*eslint-disable */
    console.log("==================================================");
    console.log("==================================================");
    console.log("==================================================");
    console.log(result);
    console.log("==================================================");
    console.log("==================================================");
    console.log("==================================================");
    /*eslint-enable */
  });
