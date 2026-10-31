'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeDomain,
  emailOnDomain,
  analyzeEmail,
  isGenericEmail,
  splitName,
  linkedinHandle,
  nameFromLinkedinUrl,
  titleScore,
  rankCandidates,
  isAcceptedVerification,
  emailStatusLabel
} = require('../src/filters');

test('normalizeDomain cleans real world input', () => {
  assert.equal(normalizeDomain('https://www.Brand.com/about?utm=1'), 'brand.com');
  assert.equal(normalizeDomain('  @Brand.COM '), 'brand.com');
  assert.equal(normalizeDomain('brand.com/partnerships'), 'brand.com');
  assert.equal(normalizeDomain('http://brand.com:8080/x'), 'brand.com');
  assert.equal(normalizeDomain('brand.com.'), 'brand.com');
  assert.equal(normalizeDomain('shop.brand.co.uk'), 'shop.brand.co.uk');
  assert.equal(normalizeDomain('https://münchen.de'), 'xn--mnchen-3ya.de');
});

test('normalizeDomain rejects things that are not public domains', () => {
  assert.equal(normalizeDomain(''), null);
  assert.equal(normalizeDomain(null), null);
  assert.equal(normalizeDomain('not a domain'), null);
  assert.equal(normalizeDomain('localhost'), null);
  assert.equal(normalizeDomain('192.168.1.1'), null);
  assert.equal(normalizeDomain('ftp://brand.com'), null);
});

test('emailOnDomain accepts sub-domains only', () => {
  assert.equal(emailOnDomain('jane@brand.com', 'brand.com'), true);
  assert.equal(emailOnDomain('jane@mail.brand.com', 'brand.com'), true);
  assert.equal(emailOnDomain('jane@brand.com', 'mail.brand.com'), true);
  assert.equal(emailOnDomain('jane@brand.co', 'brand.com'), false);
  assert.equal(emailOnDomain('jane@gmail.com', 'brand.com'), false);
  assert.equal(emailOnDomain('', 'brand.com'), false);
});

test('generic role mailboxes are detected', () => {
  for (const email of [
    'info@brand.com',
    'Support@brand.com',
    'press@brand.com',
    'hello@brand.com',
    'partnerships@brand.com',
    'info.us@brand.com',
    'support_team@brand.com',
    'press1@brand.com',
    'no-reply@brand.com',
    'marketing+uk@brand.com'
  ]) {
    assert.equal(isGenericEmail(email), true, `${email} should be generic`);
  }
});

test('personal mailboxes are not treated as generic', () => {
  for (const email of [
    'jane.doe@brand.com',
    'jdoe@brand.com',
    'jane@brand.com',
    'salesforce.jane@brand.com',
    'informed@brand.com'
  ]) {
    assert.equal(isGenericEmail(email), false, `${email} should not be generic`);
  }
  assert.equal(analyzeEmail('press@brand.com').mailbox, 'press');
  assert.match(analyzeEmail('press@brand.com').reason, /role mailbox/);
});

test('splitName handles middles, suffixes and single names', () => {
  assert.deepEqual(splitName('Jane Doe'), { firstName: 'Jane', lastName: 'Doe' });
  assert.deepEqual(splitName('Jane M. van der Doe'), { firstName: 'Jane', lastName: 'Doe' });
  assert.deepEqual(splitName('John Smith Jr.'), { firstName: 'John', lastName: 'Smith' });
  assert.deepEqual(splitName('Cher'), { firstName: 'Cher', lastName: '' });
  assert.deepEqual(splitName(''), { firstName: '', lastName: '' });
  assert.deepEqual(splitName(null), { firstName: '', lastName: '' });
});


test('LinkedIn URLs yield handles and readable names', () => {
  assert.equal(
    linkedinHandle('https://www.linkedin.com/in/jane-doe-4a7c21/'),
    'jane-doe-4a7c21'
  );
  assert.equal(linkedinHandle('https://www.linkedin.com/company/acme'), null);
  assert.equal(nameFromLinkedinUrl('https://www.linkedin.com/in/jane-doe-4a7c21'), 'Jane Doe');
  assert.equal(nameFromLinkedinUrl('https://www.linkedin.com/in/jane-mary-doe'), 'Jane Mary Doe');
  assert.equal(nameFromLinkedinUrl('https://www.linkedin.com/in/123456'), null);
  assert.equal(nameFromLinkedinUrl(null), null);
});

test('titleScore prefers influencer/partnership roles over generic marketing', () => {
  const influencer = titleScore('Head of Influencer Marketing');
  const partnerships = titleScore('Partnerships Manager');
  const creator = titleScore('Creator Relations Lead');
  const social = titleScore('Social Media Manager');
  const generic = titleScore('Marketing Manager');
  const irrelevant = titleScore('Senior Software Engineer');

  assert.ok(influencer > partnerships, 'influencer > partnerships');
  assert.ok(partnerships > social, 'partnerships > social');
  assert.ok(creator > social, 'creator > social');
  assert.ok(social > generic, 'social > generic marketing');
  assert.equal(irrelevant, 0);
  assert.equal(titleScore(''), 0);
});

test('rankCandidates filters and sorts by title score', () => {
  const people = [
    { id: 'a', title: 'Social Media Manager', has_email: false },
    { id: 'b', title: 'Head of Influencer Marketing', has_email: true },
    { id: 'c', title: 'Senior Software Engineer', has_email: true },
    { id: 'd', title: 'Creator Partnerships', has_email: false },
    { title: 'No id, ignored' }
  ];
  const ranked = rankCandidates(people);
  assert.deepEqual(ranked.map((item) => item.id), ['b', 'd', 'a']);
  assert.ok(ranked[0].score > ranked[1].score);

  const strict = rankCandidates(people, { minScore: 90 });
  assert.deepEqual(strict.map((item) => item.id), ['b', 'd']);
});

test('isAcceptedVerification follows "valid" or "deliverable"', () => {
  assert.equal(isAcceptedVerification({ status: 'valid', result: 'deliverable' }), true);
  assert.equal(isAcceptedVerification({ status: 'valid', result: 'unknown' }), true);
  assert.equal(isAcceptedVerification({ status: 'unknown', result: 'deliverable' }), true);
  assert.equal(isAcceptedVerification({ status: 'invalid', result: 'undeliverable' }), false);
  assert.equal(isAcceptedVerification({ status: 'unknown', result: 'unknown' }), false);
  assert.equal(isAcceptedVerification({ status: 'accept_all', result: 'risky' }), false);
  assert.equal(
    isAcceptedVerification({ status: 'accept_all', result: 'risky' }, { allowAcceptAll: true }),
    true
  );
  assert.equal(isAcceptedVerification({ status: 'valid', disposable: true }), false);
  assert.equal(isAcceptedVerification({ status: 'valid', block: true }), false);
});

test('emailStatusLabel reports valid/deliverable', () => {
  assert.equal(emailStatusLabel({ status: 'valid', result: 'deliverable' }), 'valid');
  assert.equal(emailStatusLabel({ status: 'unknown', result: 'deliverable' }), 'deliverable');
  assert.equal(emailStatusLabel({ status: 'accept_all', result: 'risky' }), 'accept_all');
  assert.equal(emailStatusLabel({}), 'unknown');
});
