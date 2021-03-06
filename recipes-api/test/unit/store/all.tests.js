const R = require('ramda');
const { join } = require('path');
const expect = require('expect.js');
const nock = require('nock');
const statusCodes = require('http-status-codes');
const system = require('../../../system');
const configSystem = require('../../../components/config');
const recipe = require('../../../fixtures/recipe_sample.json');
const stores = require('require-all')({
  dirname: join(__dirname, '..', '..', '..', 'components', 'store', 'types'),
  filter: (fileName) => fileName === 'index.js' ? undefined : fileName.replace('.js', '')
});

const test = (strategy) => {
  describe(`Testing store ${strategy}`, () => {
    let myStore;
    let sys;
    let myConfig;
    let myBroker;

    const mockFn = (system) =>
      system()
        .set('config', { start: (cb) => cb(null, myConfig) });

    before(done => {
      configSystem.start((err, { config }) => {
        if (err) return done(err);
        myConfig = R.merge(config, { store: { strategy, idGenerator: config.store.idGenerator } });
        sys = system(mockFn).start((err, { store, broker }) => {
          if (err) return done(err);
          myBroker = broker;
          myStore = store;
          done();
        });
      });
    });

    beforeEach(() =>
      myStore.flush()
        .then(() => myBroker.purge()));

    afterEach(() => nock.cleanAll());

    after(done =>
      myBroker.nuke()
      .then(() => sys.stop(done)));

    const nockIdGenerator = (id, expectedStatusCode = statusCodes.OK) => {
      const { host, path } = myConfig.store.idGenerator;
      nock(host)
      .get(path)
      .reply(expectedStatusCode, { id });
    };

    const shouldReceive = (expectedRK) => new Promise((resolve, reject) => {
      myBroker.subscribe('recipes_snoop', (err, subscription) => {
        if (err) return reject(err);
        subscription
        .on('message', (message, content, ackOrNack) => {
          ackOrNack();
          if (message.fields.routingKey !== expectedRK) return shouldReceive(expectedRK);
          return subscription.cancel(() => resolve({ message, content }));
        })
        .on('error', reject);
        });
    });

    const shouldNotReceive = (expectedRK) => new Promise((resolve, reject) => {
      myBroker.subscribe('recipes_snoop', (err, subscription) => {
        if (err) return reject(err);
        subscription
        .on('message', (message, content, ackOrNack) => {
          ackOrNack();
          if (message.fields.routingKey !== expectedRK) return setTimeout(() => subscription.cancel(resolve), 500);
          return shouldNotReceive(expectedRK);
        })
        .on('error', (err) => { throw err });
      });
    });

    const normalise = R.omit(['_id', 'id']);

    it('should get a recipe by id', () => {
      const expectedId = 1;
      nockIdGenerator(expectedId);
      return myStore.saveRecipe(recipe)
        .then(() => myStore.getRecipe(expectedId))
        .then((saved) => expect(normalise(saved)).to.eql(normalise(recipe)))
    });

    it('should get a recipe by source id', () => {
      const expectedId = 1;
      nockIdGenerator(expectedId);
      return myStore.saveRecipe(recipe)
        .then(() => myStore.getRecipeBySourceId(recipe.source_id))
        .then((saved) => expect(normalise(saved)).to.eql(normalise(recipe)))
    });

    it('should save a recipe with no id, requesting one for it', () => {
      const expectedId = 1;
      nockIdGenerator(expectedId);
      return myStore.saveRecipe(recipe)
        .then(() => myStore.getRecipe(expectedId))
        .then((saved) => expect(normalise(saved)).to.eql(normalise(recipe)))
        .then(() => shouldReceive('recipes_api.v1.notifications.recipe.saved'))
        .then(({ message, content }) => expect(normalise(content)).to.eql(normalise(recipe)))
    });

    it('should update a recipe when the recipe exists and the new version is greater than the saved one', () => {
      const myRecipe = R.merge(recipe, { id: 1 });
      const greaterVersion = new Date().getTime();
      const update = R.merge(myRecipe, { version: greaterVersion });
      return myStore.saveRecipe(myRecipe)
        .then(() => shouldReceive('recipes_api.v1.notifications.recipe.saved'))
        .then(() => myStore.saveRecipe(update))
        .then(() => shouldReceive('recipes_api.v1.notifications.recipe.updated'))
        .then(({ message, content }) => expect(normalise(content)).to.eql(normalise(update)))
        .then(() => myStore.getRecipe(myRecipe.id))
        .then((saved) => expect(saved.version).to.eql(greaterVersion))
    });

    it('should not update a recipe when the recipe exists and the new version is lower than the saved one', () => {
      const lowerVersion = 1;
      const myRecipe = R.merge(recipe, { id: 1 });
      const update = R.merge(myRecipe, { version: lowerVersion });
      return myStore.saveRecipe(myRecipe)
        .then(() => myStore.saveRecipe(update))
        .then(() => myStore.getRecipe(myRecipe.id))
        .then((saved) => expect(saved.version).to.eql(myRecipe.version))
        .then(() => shouldNotReceive('recipes_api.v1.notifications.recipe.updated'));
    });

    it('should throw an error when deleting a recipe with no id', () =>
      myStore.deleteRecipe(null)
        .catch((err) => expect(err.message).to.equal('Could not delete recipe with no id'))
    );

    it('should delete a recipe', () => {
      const expectedId = 1;
      nockIdGenerator(expectedId);
      return myStore.saveRecipe(recipe)
        .then(() => myStore.deleteRecipe(expectedId))
        .then(() => myStore.getRecipe(expectedId))
        .then((saved) => expect(saved).to.eql(null))
        .then(() => shouldReceive('recipes_api.v1.notifications.recipe.deleted'))
        .then(({ message, content }) => expect(content.id).to.eql(expectedId))
    });
  });
};

const runAll = R.pipe(
  R.keys,
  R.map(test)
);

runAll(stores);
