'use strict';

const EagerRelation = require('bookshelf/lib/eager');
const Relation = require('bookshelf/lib/relation');

// Never issue a query to eager-load a relation whose reference id set is empty.
//
// Bookshelf already does this - but only on the single-row path, where `eagerFetch` opens with
// `if (relatedData.parentFk === null) return;`. The eager/collection path ignores `parentFk` and
// takes its ids from `relatedData.eagerKeys(parentResponse)` instead. That helper rejects nulls, so
// when every parent row has a null foreign key the list comes back empty and knex compiles
// `whereIn(key, [])` into `where 1 = 0` - a round-trip that cannot match a row by construction.
//
// On this schema that is not a marginal case. Strapi injects `created_by` and `updated_by`
// (belongsTo admin::user) into all 100 content types, and they are only filled by writes made
// through the admin UI: 19 of 141k products and 1 of 883k orders. So nearly every populated read
// paid two guaranteed-empty SELECTs, plus one more for any other unset belongsTo - `parent_product`
// on a product without a parent, for instance.
//
// Skipping is equivalent rather than merely cheaper: the relation is left unset, which is the exact
// state it reaches when the query does run and returns nothing. And only the inverse case can be
// empty - `eagerKeys` uses the foreign key for belongsTo/morphTo and the parent ids otherwise, and
// the parent ids are never empty - so hasMany/belongsToMany/through are untouched. morphTo is left
// to its own branch, which groups parents by type before querying.
const patchSkipEmptyEagerLoad = () => {
  const original = EagerRelation.prototype.eagerFetch;

  // A bookshelf upgrade that reshapes any of this should stop the boot rather than quietly drop the
  // optimisation and leave production latency to explain it. Both halves are asserted: the method
  // being patched, and `eagerKeys`, which is what the guard below actually reads. A rename of either
  // would otherwise leave the patch installed but inert.
  if (typeof original !== 'function' || typeof Relation.prototype.eagerKeys !== 'function') {
    throw new Error(
      'bookshelf internals have moved (EagerRelation.prototype.eagerFetch / Relation.prototype.eagerKeys) - ' +
        'lib/utils/skip-empty-eager.js is stale'
    );
  }

  if (original.skipsEmptyEagerLoad === true) return;

  function eagerFetch(relationName, handled, options) {
    const relatedData = handled.relatedData;

    if (
      this.parentResponse &&
      relatedData.type !== 'morphTo' &&
      typeof relatedData.eagerKeys === 'function' &&
      relatedData.eagerKeys(this.parentResponse).length === 0
    ) {
      return;
    }

    return original.call(this, relationName, handled, options);
  }

  eagerFetch.skipsEmptyEagerLoad = true;
  EagerRelation.prototype.eagerFetch = eagerFetch;
};

module.exports = { patchSkipEmptyEagerLoad };
