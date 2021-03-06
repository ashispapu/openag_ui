import * as Config from '../openag-config.json';
import {html, forward, Effects, Task, thunk} from 'reflex';
import {merge, tagged, tag, batch} from './common/prelude';
import * as Poll from './common/poll';
import * as Template from './common/stache';
import * as Request from './common/request';
import * as Result from './common/result';
import * as Unknown from './common/unknown';
import {map as mapMaybe} from './common/maybe';
import {cursor} from './common/cursor';
import {localize} from './common/lang';
import {compose, constant} from './lang/functional';
import {findRight} from './lang/find';
import * as Chart from './environment/chart';
import * as Toolbox from './environment/toolbox';
import * as Exporter from './environment/exporter';
import * as Sidebar from './environment/sidebar';

// Variable key for environmental data point that represents temperature.
const AIR_TEMPERATURE = 'air_temperature';

// Time constants in ms
const S_MS = 1000;
const MIN_MS = S_MS * 60;
const HR_MS = MIN_MS * 60;
const DAY_MS = HR_MS * 24;
const POLL_TIMEOUT = 4 * S_MS;
const RETRY_TIMEOUT = 4 * S_MS;

// Limit to the number of datapoints that will be rendered in chart.
const MAX_DATAPOINTS = 5000;

// Actions

const NoOp = {
  type: 'NoOp'
};

const RequestOpenRecipes = {
  type: 'RequestOpenRecipes'
};

// Configure action received from parent.
export const Configure = (environmentID, environmentName, origin) => ({
  type: 'Configure',
  origin: origin,
  id: environmentID,
  name: environmentName
});

const TagExporter = tag('Exporter');
const OpenExporter = TagExporter(Exporter.Open);
const ConfigureExporter = compose(TagExporter, Exporter.Configure);

const TagSidebar = action =>
  action.type === 'RequestOpenRecipes' ?
  RequestOpenRecipes :
  tagged('Sidebar', action);

export const SetRecipe = compose(TagSidebar, Sidebar.SetRecipe);
export const SetAirTemperature = compose(TagSidebar, Sidebar.SetAirTemperature);

const TagToolbox = action =>
  action.type === 'OpenExporter' ?
  OpenExporter :
  tagged('Toolbox', action);

const TagPoll = action =>
  action.type === 'Ping' ?
  FetchLatest :
  tagged('Poll', action);

const FetchLatest = {type: 'FetchLatest'};
const Latest = tag('Latest');

// Action for fetching chart backlog.
const GetBacklog = {type: 'GetBacklog'};

// Action for the result of fetching chart backlog.
const GotBacklog = result => ({
  type: 'GotBacklog',
  result
});

const PongPoll = TagPoll(Poll.Pong);
const MissPoll = TagPoll(Poll.Miss);

const TagChart = tag('Chart');
const AddChartData = compose(TagChart, Chart.AddData);
const ChartLoading = compose(TagChart, Chart.Loading);

// Send an alert. We use this to send up problems to be displayed in banner.
const AlertBanner = tag('AlertBanner');

// Map an incoming datapoint into an action
const DataPointAction = dataPoint => {
  console.log(DataPoint);
}

// Model init and update

export const init = id => {
  const [poll, pollFx] = Poll.init(POLL_TIMEOUT);
  const [chart, chartFx] = Chart.init();
  const [exporter, exporterFx] = Exporter.init();
  const [sidebar, sidebarFx] = Sidebar.init();

  return [
    {
      id,
      chart,
      poll,
      exporter,
      sidebar
    },
    Effects.batch([
      chartFx.map(TagChart),
      pollFx.map(TagPoll),
      exporterFx.map(TagExporter),
      sidebarFx.map(TagSidebar)
    ])
  ];
};

// Serialize environment for storing locally.
export const serialize = model => ({
  id: model.id,
  name: model.name
});

export const update = (model, action) =>
  action.type === 'NoOp' ?
  [model, Effects.none] :
  action.type === 'Poll' ?
  updatePoll(model, action.source) :
  action.type === 'Exporter' ?
  updateExporter(model, action.source) :
  action.type === 'Chart' ?
  updateChart(model, action.source) :
  action.type === 'Sidebar' ?
  updateSidebar(model, action.source) :
  action.type === 'FetchLatest' ?
  fetchLatest(model) :
  action.type === 'Latest' ?
  updateLatest(model, action.source) :
  action.type === 'GetBacklog' ?
  getBacklog(model) :
  action.type === 'GotBacklog' ?
  updateBacklog(model, action.result) :
  action.type === 'Configure' ?
  configure(model, action) :
  Unknown.update(model, action);

const fetchLatest = model => {
  if (model.origin && model.id) {
    const url = templateLatestUrl(model.origin, model.id);
    return [model, Request.get(url).map(Latest)];
  }
  else {
    console.warn('fetchLatest was called before origin and ID were restored on model');
    return [model, Effects.none];
  }
}

const updateLatest = Result.updater(
  (model, record) => {
    const data = readData(record);
    const airTemperature = findAirTemperature(data);

    return batch(update, model, [
      AddChartData(data),
      SetAirTemperature(airTemperature),
      PongPoll
    ]);
  },
  (model, error) => {
    // Send miss poll
    const [next, fx] = update(model, MissPoll);

    // Create alert action
    const action = AlertBanner(error);

    return [
      next,
      // Batch any effect generated by MissPoll with the alert effect.
      Effects.batch([
        fx,
        Effects.receive(action)
      ])
    ];
  }
);

const getBacklog = model => {
  if (model.origin && model.id) {
    const url = templateRecentUrl(model.origin, model.id);
    return [model, Request.get(url).map(GotBacklog)];
  }
  else {
    console.warn('GetBacklog was requested before origin and ID were restored on model');
    return [model, Effects.none];
  }
}

// Update chart backlog from result of fetch.
const updateBacklog = Result.updater(
  (model, record) => {
    const data = readData(record);
    const airTemperature = findAirTemperature(data);

    return batch(update, model, [
      AddChartData(data),
      SetAirTemperature(airTemperature),
      FetchLatest
    ]);
  },
  (model, error) => {
    const action = AlertBanner(error);

    return [
      model,
      Effects.batch([
        // Wait for a second, then try to get backlog again.
        Effects.perform(Task.sleep(RETRY_TIMEOUT)).map(constant(GetBacklog)),
        Effects.receive(action)
      ])
    ];
  }
);

const configure = (model, {origin, id, name}) => {
  const next = merge(model, {
    origin,
    id,
    name
  });

  return batch(update, next, [
    // Forward restore down to exporter module.
    ConfigureExporter(origin),
    // Now that we have the origin, get the backlog.
    GetBacklog
  ]);
}

const updateSidebar = cursor({
  get: model => model.sidebar,
  set: (model, sidebar) => merge(model, {sidebar}),
  update: Sidebar.update,
  tag: TagSidebar
});

const updateChart = cursor({
  get: model => model.chart,
  set: (model, chart) => merge(model, {chart}),
  update: Chart.update,
  tag: TagChart
});

const updateExporter = cursor({
  get: model => model.exporter,
  set: (model, exporter) => merge(model, {exporter}),
  update: Exporter.update,
  tag: TagExporter
});

const updatePoll = cursor({
  get: model => model.poll,
  set: (model, poll) => merge(model, {poll}),
  update: Poll.update,
  tag: TagPoll
});

// View

export const view = (model, address) =>
  model.id ?
  viewReady(model, address) :
  viewWaiting(model, address);

const viewReady = (model, address) =>
  html.div({
    className: 'environment-main environment-main--has-sidebar'
  }, [
    thunk('chart', Chart.view, model.chart, forward(address, TagChart)),
    thunk(
      'sidebar',
      Sidebar.view,
      model.sidebar,
      forward(address, TagSidebar)
    ),
    thunk('chart-toolbox', Toolbox.view, model, forward(address, TagToolbox)),
    thunk(
      'chart-export',
      Exporter.view,
      model.exporter,
      forward(address, TagExporter),
      model.id
    )
  ]);

const viewWaiting= (model, address) =>
  html.div({
    className: 'environment-main environment-main--has-sidebar'
  }, [
    thunk(
      'sidebar',
      Sidebar.view,
      model.sidebar,
      forward(address, TagSidebar)
    ),
    html.div({
      className: 'environment-content environment-content--loading'
    })
  ]);

// Helpers

const readRow = row => row.value;
// @FIXME must check that the value returned from http call is JSON and has
// this structure before mapping.
const readRecord = record => record.rows.map(readRow);

const compareByTimestamp = (a, b) =>
  a.timestamp > b.timestamp ? 1 : -1;

// @TODO we should distinguish between datapoint types so we know what values
// to parse to.
const readDataPoint = ({variable, is_desired, timestamp, value}) => ({
  variable,
  timestamp,
  is_desired,
  value: Number.parseFloat(value)
});

const readData = record => {
  const data = readRecord(record).map(readDataPoint);
  data.sort(compareByTimestamp);
  return data;
};

// Create a url string that allows you to GET latest environmental datapoints
// from an environmen via CouchDB.
const templateLatestUrl = (origin, id) =>
  Template.render(Config.environmental_data_point.origin_latest, {
    origin_url: origin,
    startkey: JSON.stringify([id]),
    endkey: JSON.stringify([id, {}])
  });

const templateRecentUrl = (origin, id) =>
  Template.render(Config.environmental_data_point.origin_range, {
    origin_url: origin,
    startkey: JSON.stringify([id, {}]),
    endkey: JSON.stringify([id]),
    limit: MAX_DATAPOINTS,
    descending: true
  });

const isAirTemperature = dataPoint => dataPoint.variable === AIR_TEMPERATURE;

const getValue = dataPoint => dataPoint.value;

const findAirTemperature = data =>
  mapMaybe(findRight(data, isAirTemperature), getValue);