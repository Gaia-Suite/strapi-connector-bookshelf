'use strict';

const _ = require('lodash');
const {
  bindPopulateQueries,
  extendWithPopulateQueries,
  queryOptionsToQueryMap,
} = require('./utils/populate-queries');
const { getComponentAttributes, isComponent } = require('./utils/attributes');
const { isPolymorphic } = require('./utils/associations');

/**
 * Create utilities to populate a model on fetch
 */
const populateFetch = (definition, options) => {
  // do not populate anything
  if (options.withRelated === false) return;
  if (options.isEager === true) return;

  if (_.isNil(options.withRelated)) {
    options.withRelated = []
      .concat(populateComponents(definition, options))
      .concat(populateAssociations(definition, options));
  } else if (_.isEmpty(options.withRelated)) {
    options.withRelated = populateComponents(definition, options);
  } else {
    options.withRelated = []
      .concat(formatPopulateOptions(definition, options))
      .concat(populateComponents(definition, options));
  }
};

const populateAssociations = (definition, options = {}) => {
  return definition.associations
    .filter(ast => ast.autoPopulate !== false)
    .map(assoc => {
      if (isPolymorphic({ assoc })) {
        return formatPolymorphicPopulate({ assoc }, options);
      }

      return formatAssociationPopulate({ assoc }, options);
    })
    .reduce((acc, val) => acc.concat(val), []);
};

const populateBareAssociations = (definition, options = {}) => {
  const { prefix = '', ...queryOptions } = options;

  return (definition.associations || [])
    .filter(ast => ast.autoPopulate !== false)
    .map(assoc => {
      if (isPolymorphic({ assoc })) {
        return formatPolymorphicPopulate({ assoc }, options);
      }

      const path = `${prefix}${assoc.alias}`;
      const assocModel = strapi.db.getModelByAssoc(assoc);

      // One level only: a relation declared in a component loads, its own media does not (see
      // formatAssociationPopulate)
      return [bindPopulateQueries([path], queryOptionsToQueryMap(queryOptions, { model: assocModel }))];
    })
    .reduce((acc, val) => acc.concat(val), []);
};

const formatAssociationPopulate = ({ assoc }, options = {}) => {
  const { prefix = '', ...queryOptions } = options;

  const path = `${prefix}${assoc.alias}`;
  const assocModel = strapi.db.getModelByAssoc(assoc);

  // One level only: the related model's own media and components are loaded when named explicitly
  // (see formatPopulateOptions), never implicitly - that cascade cost 3 upload_file_morph round-trips
  // on `companies` for every read of the 87 models that carry a `company` relation.
  return [bindPopulateQueries([path], queryOptionsToQueryMap(queryOptions, { model: assocModel }))];
};

const populateComponents = (definition, options = {}) => {
  return getComponentAttributes(definition)
    .map(key => {
      const attribute = definition.attributes[key];
      const autoPopulate = _.get(attribute, ['autoPopulate'], true);

      if (autoPopulate === true) {
        return populateComponent(key, attribute, options);
      }
    })
    .reduce((acc, val) => acc.concat(val), []);
};

const populateComponent = (key, attr, options = {}) => {
  const { prefix = '', ...queryOptions } = options;

  const path = `${prefix}${key}.component`;
  const componentPrefix = `${path}.`;

  if (attr.type === 'dynamiczone') {
    const componentKeys = attr.components;

    return componentKeys.reduce((acc, key) => {
      const component = strapi.components[key];
      const assocs = populateBareAssociations(component, {
        prefix: componentPrefix,
        ...queryOptions,
      });

      const components = populateComponents(component, {
        prefix: componentPrefix,
        ...queryOptions,
      });

      return acc.concat([path, ...assocs, ...components]);
    }, []);
  }

  const component = strapi.components[attr.component];
  const assocs = populateBareAssociations(component, { prefix: componentPrefix, ...queryOptions });

  const components = populateComponents(component, { prefix: componentPrefix, ...queryOptions });

  return [path, ...assocs, ...components];
};

// populateComponent returns bookshelf's mixed form (path strings and { path: fn } objects); fold it into
// the single { path: fn } map formatPopulateOptions builds.
const toPopulateMap = entries =>
  entries.reduce((acc, entry) => _.extend(acc, _.isString(entry) ? { [entry]: () => {} } : entry), {});

const formatPopulateOptions = (definition, { withRelated, ...queryOptions } = {}) => {
  if (!Array.isArray(withRelated)) withRelated = [withRelated];

  const obj = withRelated.reduce((acc, key) => {
    if (_.isString(key)) {
      acc[key] = () => {};
      return acc;
    }

    return _.extend(acc, key);
  }, {});

  const finalObj = Object.keys(obj).reduce((acc, key) => {
    // check the key path and update it if necessary
    const parts = key.split('.');

    let newKey;
    let prefix = '';
    let tmpModel = definition;
    for (let part of parts) {
      const attr = tmpModel.attributes[part];

      if (isComponent(tmpModel, part)) {
        // Register the component like a root component is (populateComponent: `<path>.component`, the
        // component's relations, its nested components), so `'order_locations.shipping_address'` loads
        // the addresses. Before this the branch only moved the cursor and the path was silently dropped.
        _.extend(acc, toPopulateMap(populateComponent(part, attr, { prefix, ...queryOptions })));

        if (attr.type === 'dynamiczone') break; // cannot walk into a zone: its components differ per row

        tmpModel = strapi.components[attr.component];
        newKey = `${prefix}${part}.component`;
        prefix = `${newKey}.`;
        continue;
      }

      const assoc = tmpModel.associations.find(association => association.alias === part);

      if (!assoc) return acc;

      tmpModel = strapi.db.getModelByAssoc(assoc);

      if (isPolymorphic({ assoc })) {
        const path = formatPolymorphicPopulate({ assoc }, { prefix, ...queryOptions });

        return _.extend(acc, path);
      }

      newKey = `${prefix}${part}`;
      prefix = `${newKey}.`;

      _.extend(acc, {
        [newKey]: extendWithPopulateQueries(
          [obj[newKey], acc[newKey]],
          queryOptionsToQueryMap(queryOptions, { model: tmpModel })
        ),
      });
    }

    return acc;
  }, {});

  return [finalObj];
};

const defaultOrderBy = qb => qb.orderBy('created_at', 'desc');

const formatPolymorphicPopulate = ({ assoc }, options = {}) => {
  const { prefix = '', ...queryOptions } = options;

  const model = strapi.db.getModelByAssoc(assoc);

  const queryMap = queryOptionsToQueryMap(queryOptions, { model });

  // MorphTo side.
  if (assoc.related) {
    return bindPopulateQueries([`${prefix}${assoc.alias}.related`], queryMap);
  }

  // oneToMorph or manyToMorph side.
  // Retrieve collection name because we are using it to build our hidden model.
  const path = `${prefix}${assoc.alias}.${model.collectionName}`;

  return {
    [path]: extendWithPopulateQueries([defaultOrderBy], queryMap),
  };
};

module.exports = populateFetch;
