'use strict';

/**
 * Module dependencies
 */

// Public node modules.
const _ = require('lodash');

// Utils
const {
  models: { getValuePrimaryKey },
} = require('strapi-utils');

const transformToArrayID = array => {
  if (_.isArray(array)) {
    return array
      .map(value => _.get(value, 'id') || value)
      .filter(n => n)
      .map(val => _.toString(val));
  }

  return transformToArrayID([array]);
};

const removeUndefinedKeys = obj => _.pickBy(obj, _.negate(_.isUndefined));

// Natures whose branch in `update` below reads the previously stored value to compute a diff.
const NATURES_TO_DIFF = ['oneToOne', 'oneToMany', 'manyToMany', 'manyWay'];

const addRelationMorph = async (model, { params, transacting } = {}) => {
  return await model.morph.forge().save(
    {
      [`${model.collectionName}_id`]: params.id,
      [`${params.alias}_id`]: params.refId,
      [`${params.alias}_type`]: params.ref,
      field: params.field,
      order: params.order,
    },
    // no `initialize` on the morph model, so the autoRefresh default does not reach it
    { transacting, autoRefresh: false }
  );
};

const removeRelationMorph = async (model, { params, transacting } = {}) => {
  return await model.morph
    .forge()
    .where(
      _.omitBy(
        {
          [`${model.collectionName}_id`]: params.id,
          [`${params.alias}_id`]: params.refId,
          [`${params.alias}_type`]: params.ref,
          field: params.field,
        },
        _.isUndefined
      )
    )
    .destroy({
      require: false,
      transacting,
    });
};

module.exports = {
  async findOne(params, populate, { transacting } = {}) {
    const record = await this.forge({
      [this.primaryKey]: getValuePrimaryKey(params, this.primaryKey),
    }).fetch({
      transacting,
      withRelated: populate,
    });

    return record ? record.toJSON() : record;
  },

  async update(params, { transacting } = {}) {
    const relationUpdates = [];
    const primaryKeyValue = getValuePrimaryKey(params, this.primaryKey);

    // Only these four natures read the stored value of a relation in order to diff it
    // (`response[current]`); every other branch needs the primary key alone, which params carries.
    // Passing `null` here is what made this a full default populate - populate.js treats null and
    // undefined alike - so name the aliases, and skip the read entirely when none of them apply.
    const aliases_to_diff = Object.keys(removeUndefinedKeys(params.values)).filter(alias => {
      const association = this.associations.find(x => x.alias === alias);
      return association && NATURES_TO_DIFF.includes(association.nature);
    });

    const response =
      aliases_to_diff.length > 0
        ? await module.exports.findOne.call(this, params, aliases_to_diff, { transacting })
        : null;

    // Only update fields which are on this document.
    const values = Object.keys(removeUndefinedKeys(params.values)).reduce((acc, current) => {
      const property = params.values[current];
      const association = this.associations.filter(x => x.alias === current)[0];
      const details = this._attributes[current];

      if (!association && _.get(details, 'isVirtual') !== true) {
        return _.set(acc, current, property);
      }

      const assocModel = strapi.db.getModel(details.model || details.collection, details.plugin);

      switch (association.nature) {
        case 'oneWay': {
          return _.set(acc, current, _.get(property, assocModel.primaryKey, property));
        }
        case 'oneToOne': {
          if (response[current] === property) return acc;

          if (_.isNull(property)) {
            const updatePromise = assocModel
              .where({
                [assocModel.primaryKey]: getValuePrimaryKey(
                  response[current],
                  assocModel.primaryKey
                ),
              })
              .save(
                { [details.via]: null },
                {
                  method: 'update',
                  patch: true,
                  require: false,
                  transacting,
                }
              );

            relationUpdates.push(updatePromise);
            return _.set(acc, current, null);
          }

          // set old relations to null
          const updateLink = this.where({ [current]: property })
            .save(
              { [current]: null },
              {
                method: 'update',
                patch: true,
                require: false,
                transacting,
              }
            )
            .then(() => {
              return assocModel.where({ [this.primaryKey]: property }).save(
                { [details.via]: primaryKeyValue },
                {
                  method: 'update',
                  patch: true,
                  require: false,
                  transacting,
                }
              );
            });

          // set new relation
          relationUpdates.push(updateLink);
          return _.set(acc, current, property);
        }
        case 'oneToMany': {
          // receive array of ids or array of objects with ids

          // set relation to null for all the ids not in the list
          const currentIds = response[current];
          const toRemove = _.differenceWith(currentIds, property, (a, b) => {
            return `${a[assocModel.primaryKey] || a}` === `${b[assocModel.primaryKey] || b}`;
          });

          // `where in []` compiles to `where 1 = 0`, so either half with an empty id list costs a
          // statement that cannot match a row. Both need guarding: `deleteRelations` sets [] for every
          // oneToMany alias, which makes `property` empty on every delete.
          const detachRemoved = () =>
            assocModel
              .where(
                assocModel.primaryKey,
                'in',
                toRemove.map(val => val[assocModel.primaryKey] || val)
              )
              .save(
                { [details.via]: null },
                {
                  method: 'update',
                  patch: true,
                  require: false,
                  transacting,
                }
              );

          const attachCurrent = () =>
            assocModel
              .where(
                assocModel.primaryKey,
                'in',
                property.map(val => val[assocModel.primaryKey] || val)
              )
              .save(
                { [details.via]: primaryKeyValue },
                {
                  method: 'update',
                  patch: true,
                  require: false,
                  transacting,
                }
              );

          const steps = [];
          if (toRemove.length > 0) steps.push(detachRemoved);
          if (property.length > 0) steps.push(attachCurrent);

          // sequential: the old owner has to be cleared before the new one is set
          const updatePromise = steps.reduce((chain, step) => chain.then(step), Promise.resolve());

          relationUpdates.push(updatePromise);
          return acc;
        }
        case 'manyToOne': {
          return _.set(acc, current, _.get(property, assocModel.primaryKey, property));
        }
        case 'manyWay':
        case 'manyToMany': {
          const storedValue = transformToArrayID(response[current]);
          const currentValue = transformToArrayID(params.values[current]);

          const toAdd = _.difference(currentValue, storedValue);
          const toRemove = _.difference(storedValue, currentValue);

          const collection = this.forge({
            [this.primaryKey]: primaryKeyValue,
          })[association.alias]();

          const updatePromise = collection
            .detach(toRemove, { transacting })
            .then(() => collection.attach(toAdd, { transacting }));

          relationUpdates.push(updatePromise);
          return acc;
        }
        // media -> model
        case 'manyMorphToMany':
        case 'manyMorphToOne': {
          // Update the relational array.
          const refs = params.values[current];

          if (Array.isArray(refs) && refs.length === 0) {
            // clear related
            relationUpdates.push(
              removeRelationMorph(this, { params: { id: primaryKeyValue }, transacting })
            );
            break;
          }

          refs.forEach(obj => {
            const targetModel = strapi.db.getModel(
              obj.ref,
              obj.source !== 'content-manager' ? obj.source : null
            );

            const reverseAssoc = targetModel.associations.find(assoc => assoc.alias === obj.field);

            // Remove existing relationship because only one file
            // can be related to this field.
            if (reverseAssoc && reverseAssoc.nature === 'oneToManyMorph') {
              relationUpdates.push(
                removeRelationMorph(this, {
                  params: {
                    alias: association.alias,
                    ref: targetModel.collectionName,
                    refId: obj.refId,
                    field: obj.field,
                  },
                  transacting,
                }).then(() =>
                  addRelationMorph(this, {
                    params: {
                      id: primaryKeyValue,
                      alias: association.alias,
                      ref: targetModel.collectionName,
                      refId: obj.refId,
                      field: obj.field,
                      order: 1,
                    },
                    transacting,
                  })
                )
              );

              return;
            }

            const addRelation = async () => {
              const maxOrder = await this.morph
                .query(qb => {
                  qb.max('order as order').where({
                    [`${association.alias}_id`]: obj.refId,
                    [`${association.alias}_type`]: targetModel.collectionName,
                    field: obj.field,
                  });
                })
                .fetch({ transacting });

              const { order = 0 } = maxOrder.toJSON();

              await addRelationMorph(this, {
                params: {
                  id: primaryKeyValue,
                  alias: association.alias,
                  ref: targetModel.collectionName,
                  refId: obj.refId,
                  field: obj.field,
                  order: order + 1,
                },
                transacting,
              });
            };

            relationUpdates.push(addRelation());
          });
          break;
        }
        // model -> media
        case 'oneToManyMorph':
        case 'manyToManyMorph': {
          const currentValue = transformToArrayID(params.values[current]);

          const model = strapi.db.getModel(details.collection || details.model, details.plugin);

          const promise = removeRelationMorph(model, {
            params: {
              alias: association.via,
              ref: this.collectionName,
              refId: primaryKeyValue,
              field: association.alias,
            },
            transacting,
          }).then(() => {
            return Promise.all(
              currentValue.map((id, idx) => {
                return addRelationMorph(model, {
                  params: {
                    id,
                    alias: association.via,
                    ref: this.collectionName,
                    refId: primaryKeyValue,
                    field: association.alias,
                    order: idx + 1,
                  },
                  transacting,
                });
              })
            );
          });

          relationUpdates.push(promise);

          break;
        }
        case 'oneMorphToOne':
        case 'oneMorphToMany': {
          break;
        }
        default:
      }

      return acc;
    }, {});

    await Promise.all(relationUpdates);

    delete values[this.primaryKey];
    if (!_.isEmpty(values)) {
      await this.forge({
        [this.primaryKey]: getValuePrimaryKey(params, this.primaryKey),
      }).save(values, {
        patch: true,
        transacting,
      });
    }

    const result = await this.forge({
      [this.primaryKey]: getValuePrimaryKey(params, this.primaryKey),
    }).fetch({
      transacting,
    });

    return result && result.toJSON ? result.toJSON() : result;
  },

  deleteRelations(id, { transacting }) {
    const values = {};

    this.associations.map(association => {
      switch (association.nature) {
        case 'oneWay':
        case 'oneToOne':
        case 'manyToOne':
        case 'oneToManyMorph':
          values[association.alias] = null;
          break;
        case 'manyWay':
        case 'oneToMany':
        case 'manyToMany':
        case 'manyToManyMorph':
        case 'manyMorphToMany':
        case 'manyMorphToOne':
          values[association.alias] = [];
          break;
        default:
      }
    });

    return this.updateRelations({ [this.primaryKey]: id, values }, { transacting });
  },
};
