import $ from 'jquery';
import React from 'react';
import ReactDOM from 'react-dom';
var commonMsg = require('@cdo/locale');
var msg = require('@cdo/gamelab/locale');
var levels = require('./levels');
var codegen = require('../codegen');
var apiJavascript = require('./apiJavascript');
var consoleApi = require('../consoleApi');
var ProtectedStatefulDiv = require('../templates/ProtectedStatefulDiv');
var utils = require('../utils');
var dropletUtils = require('../dropletUtils');
var _ = require('lodash');
var dropletConfig = require('./dropletConfig');
var JsDebuggerUi = require('../JsDebuggerUi');
var JSInterpreter = require('../JSInterpreter');
var JsInterpreterLogger = require('../JsInterpreterLogger');
var GameLabP5 = require('./GameLabP5');
var gameLabSprite = require('./GameLabSprite');
var gameLabGroup = require('./GameLabGroup');
var assetPrefix = require('../assetManagement/assetPrefix');
var gamelabCommands = require('./commands');
var errorHandler = require('../errorHandler');
var outputError = errorHandler.outputError;
var ErrorLevel = errorHandler.ErrorLevel;
var dom = require('../dom');
var experiments = require('../experiments');

import {setInitialAnimationList, saveAnimations} from './animationListModule';
import {getSerializedAnimationList} from './PropTypes';
var reducers = require('./reducers');
var GameLabView = require('./GameLabView');
var Provider = require('react-redux').Provider;
import { shouldOverlaysBeVisible } from '../templates/VisualizationOverlay';
import {GAME_WIDTH} from './constants';

var MAX_INTERPRETER_STEPS_PER_TICK = 500000;

var ButtonState = {
  UP: 0,
  DOWN: 1
};

var ArrowIds = {
  LEFT: 'leftButton',
  UP: 'upButton',
  RIGHT: 'rightButton',
  DOWN: 'downButton'
};

/**
 * An instantiable GameLab class
 */
var GameLab = function () {
  this.skin = null;
  this.level = null;
  this.tickIntervalId = 0;
  this.tickCount = 0;

  /** @type {StudioApp} */
  this.studioApp_ = null;

  /** @type {JSInterpreter} */
  this.JSInterpreter = null;

  /** @private {JsInterpreterLogger} */
  this.consoleLogger_ = new JsInterpreterLogger(window.console);

  /** @type {JsDebuggerUi} */
  this.debugger_ = null;

  this.eventHandlers = {};
  this.Globals = {};
  this.btnState = {};
  this.dPadState = {};
  this.currentCmdQueue = null;
  this.interpreterStarted = false;
  this.globalCodeRunsDuringPreload = false;
  this.drawInProgress = false;
  this.setupInProgress = false;
  this.reportPreloadEventHandlerComplete_ = null;
  this.gameLabP5 = new GameLabP5();
  this.apiJS = apiJavascript;
  this.apiJS.injectGameLab(this);

  dropletConfig.injectGameLab(this);

  consoleApi.setLogMethod(this.log.bind(this));
  errorHandler.setLogMethod(this.log.bind(this));

  /** Expose for testing **/
  window.__mostRecentGameLabInstance = this;

  /** Expose for levelbuilder */
  window.printSerializedAnimationList = () => {
    this.getSerializedAnimationList(list => {
      console.log(JSON.stringify(list, null, 2));
    });
  };
};

module.exports = GameLab;

/**
 * Forward a log message to both logger objects.
 * @param {?} object
 */
GameLab.prototype.log = function (object) {
  this.consoleLogger_.log(object);
  if (this.debugger_) {
    this.debugger_.log(object);
  }
};

/**
 * Inject the studioApp singleton.
 */
GameLab.prototype.injectStudioApp = function (studioApp) {
  this.studioApp_ = studioApp;
  this.studioApp_.reset = this.reset.bind(this);
  this.studioApp_.runButtonClick = this.runButtonClick.bind(this);

  this.studioApp_.setCheckForEmptyBlocks(true);
};

GameLab.baseP5loadImage = null;

/**
 * Initialize Blockly and this GameLab instance.  Called on page load.
 * @param {!AppOptionsConfig} config
 * @param {!GameLabLevel} config.level
 */
GameLab.prototype.init = function (config) {
  if (!this.studioApp_) {
    throw new Error("GameLab requires a StudioApp");
  }

  if (!config.level.editCode) {
    throw 'Game Lab requires Droplet';
  }

  this.skin = config.skin;
  this.skin.smallStaticAvatar = null;
  this.skin.staticAvatar = null;
  this.skin.winAvatar = null;
  this.skin.failureAvatar = null;
  this.level = config.level;

  this.level.softButtons = this.level.softButtons || {};
  if (this.level.startAnimations && this.level.startAnimations.length > 0) {
    try {
      this.startAnimations = JSON.parse(this.level.startAnimations);
    } catch (err) {
      console.error("Unable to parse default animation list", err);
    }
  }

  config.usesAssets = true;

  gameLabSprite.injectLevel(this.level);

  this.gameLabP5.init({
    gameLab: this,
    onExecutionStarting: this.onP5ExecutionStarting.bind(this),
    onPreload: this.onP5Preload.bind(this),
    onSetup: this.onP5Setup.bind(this),
    onDraw: this.onP5Draw.bind(this)
  });

  config.afterClearPuzzle = function () {
    this.studioApp_.reduxStore.dispatch(setInitialAnimationList(this.startAnimations));
    this.studioApp_.resetButtonClick();
  }.bind(this);

  config.dropletConfig = dropletConfig;
  config.appMsg = msg;

  // hide makeYourOwn on the share page
  config.makeYourOwn = false;

  config.centerEmbedded = false;
  config.wireframeShare = true;
  config.noHowItWorks = true;

  config.shareWarningInfo = {
    hasDataAPIs: function () {
      return this.hasDataStoreAPIs(this.studioApp_.getCode());
    }.bind(this),
    onWarningsComplete: function () {
      window.setTimeout(this.studioApp_.runButtonClick, 0);
    }.bind(this)
  };

  // Provide a way for us to have top pane instructions disabled by default, but
  // able to turn them on.
  config.showInstructionsInTopPane = true;
  config.noInstructionsWhenCollapsed = true;

  config.enableShowCode = false;
  config.enableShowLinesCount = false;

  // TODO(caleybrock): Should be depenedent on !config.level.debuggerDisabled,
  // but disabled until bugs fixed.
  var breakpointsEnabled = false;

  var onMount = function () {
    this.setupReduxSubscribers(this.studioApp_.reduxStore);
    config.loadAudio = this.loadAudio_.bind(this);
    config.afterInject = this.afterInject_.bind(this, config);
    config.afterEditorReady = this.afterEditorReady_.bind(this, breakpointsEnabled);

    // Store p5specialFunctions in the unusedConfig array so we don't give warnings
    // about these functions not being called:
    config.unusedConfig = this.gameLabP5.p5specialFunctions;

    this.studioApp_.init(config);

    var finishButton = document.getElementById('finishButton');
    if (finishButton) {
      dom.addClickTouchEvent(finishButton, this.onPuzzleComplete.bind(this, false));
    }

    if (this.debugger_) {
      this.debugger_.initializeAfterDomCreated({
        defaultStepSpeed: 1
      });
    }

    this.setCrosshairCursorForPlaySpace();
  }.bind(this);

  var showFinishButton = !this.level.isProjectLevel;
  var finishButtonFirstLine = _.isEmpty(this.level.softButtons);

  // TODO(caleybrock): Should be dependent on (!config.hideSource && !config.level.debuggerDisabled),
  // but disabled until debug bugs fixed.
  var showDebugButtons = false;

  var showDebugConsole = !config.hideSource;

  if (showDebugButtons || showDebugConsole) {
    this.debugger_ = new JsDebuggerUi(this.runButtonClick.bind(this), this.studioApp_.reduxStore);
  }

  this.studioApp_.setPageConstants(config, {
    channelId: config.channel,
    nonResponsiveVisualizationColumnWidth: GAME_WIDTH,
    showDebugButtons: showDebugButtons,
    showDebugConsole: showDebugConsole,
    showDebugWatch: true,
    showDebugSlider: false,
    showAnimationMode: !config.level.hideAnimationMode
  });

  // Push project-sourced animation metadata into store
  const initialAnimationList = config.initialAnimationList || this.startAnimations;
  this.studioApp_.reduxStore.dispatch(setInitialAnimationList(initialAnimationList));

  ReactDOM.render((
    <Provider store={this.studioApp_.reduxStore}>
      <GameLabView
        showFinishButton={finishButtonFirstLine && showFinishButton}
        onMount={onMount}
      />
    </Provider>
  ), document.getElementById(config.containerId));

  this.studioApp_.notifyInitialRenderComplete(config);
};

/**
 * Subscribe to state changes on the store.
 * @param {!Store} store
 */
GameLab.prototype.setupReduxSubscribers = function (store) {
  var state = {};
  store.subscribe(() => {
    var lastState = state;
    state = store.getState();

    if (!lastState.runState || state.runState.isRunning !== lastState.runState.isRunning) {
      this.onIsRunningChange(state.runState.isRunning);
    }
  });
};

GameLab.prototype.onIsRunningChange = function () {
  this.setCrosshairCursorForPlaySpace();
};

/**
 * Hopefully a temporary measure - we do this ourselves for now because this is
 * a 'protected' div that React doesn't update, but eventually would rather do
 * this with React.
 */
GameLab.prototype.setCrosshairCursorForPlaySpace = function () {
  var showOverlays = shouldOverlaysBeVisible(this.studioApp_.reduxStore.getState());
  $('#divGameLab').toggleClass('withCrosshair', showOverlays);
};

GameLab.prototype.loadAudio_ = function () {
  this.studioApp_.loadAudio(this.skin.winSound, 'win');
  this.studioApp_.loadAudio(this.skin.startSound, 'start');
  this.studioApp_.loadAudio(this.skin.failureSound, 'failure');
};

GameLab.prototype.calculateVisualizationScale_ = function () {
  var divGameLab = document.getElementById('divGameLab');
  // Calculate current visualization scale:
  return divGameLab.getBoundingClientRect().width / divGameLab.offsetWidth;
};

/**
 * @param {string} code The code to search for Data Storage APIs
 * @return {boolean} True if the code uses any data storage APIs
 */
GameLab.prototype.hasDataStoreAPIs = function (code) {
  return /createRecord/.test(code) || /updateRecord/.test(code) ||
      /setKeyValue/.test(code);
};

/**
 * Code called after the blockly div + blockly core is injected into the document
 */
GameLab.prototype.afterInject_ = function (config) {

  // Connect up arrow button event handlers
  for (var btn in ArrowIds) {
    dom.addMouseUpTouchEvent(document.getElementById(ArrowIds[btn]),
        this.onArrowButtonUp.bind(this, ArrowIds[btn]));
    dom.addMouseDownTouchEvent(document.getElementById(ArrowIds[btn]),
        this.onArrowButtonDown.bind(this, ArrowIds[btn]));
  }
  if (this.level.showDPad) {
    dom.addMouseDownTouchEvent(document.getElementById('studio-dpad-button'),
        this.onDPadButtonDown.bind(this));
  }
  // Can't use dom.addMouseUpTouchEvent() because it will preventDefault on
  // all touchend events on the page, breaking click events...
  document.addEventListener('mouseup', this.onMouseUp.bind(this), false);
  var mouseUpTouchEventName = dom.getTouchEventName('mouseup');
  if (mouseUpTouchEventName) {
    document.body.addEventListener(mouseUpTouchEventName, this.onMouseUp.bind(this));
  }

  if (this.studioApp_.isUsingBlockly()) {
    // Add to reserved word list: API, local variables in execution evironment
    // (execute) and the infinite loop detection function.
    Blockly.JavaScript.addReservedWords('GameLab,code');
  }

  // Update gameLabP5's scale and keep it updated with future resizes:
  this.gameLabP5.scale = this.calculateVisualizationScale_();

  window.addEventListener('resize', function () {
    this.gameLabP5.scale = this.calculateVisualizationScale_();
  }.bind(this));
};

/**
 * Initialization to run after ace/droplet is initialized.
 * @param {!boolean} areBreakpointsEnabled
 * @private
 */
GameLab.prototype.afterEditorReady_ = function (areBreakpointsEnabled) {
  if (areBreakpointsEnabled) {
    this.studioApp_.enableBreakpoints();
  }
};

GameLab.prototype.haltExecution_ = function () {
  this.eventHandlers = {};
  if (this.tickIntervalId !== 0) {
    window.clearInterval(this.tickIntervalId);
  }
  this.tickIntervalId = 0;
  this.tickCount = 0;
};

/**
 * Reset GameLab to its initial state.
 * @param {boolean} ignore Required by the API but ignored by this
 *     implementation.
 */
GameLab.prototype.reset = function (ignore) {
  this.haltExecution_();

  /*
  var divGameLab = document.getElementById('divGameLab');
  while (divGameLab.firstChild) {
    divGameLab.removeChild(divGameLab.firstChild);
  }
  */

  this.gameLabP5.resetExecution();

  // Import to reset these after this.gameLabP5 has been reset
  this.drawInProgress = false;
  this.setupInProgress = false;
  this.reportPreloadEventHandlerComplete_ = null;
  this.globalCodeRunsDuringPreload = false;

  if (this.debugger_) {
    this.debugger_.detach();
  }
  this.consoleLogger_.detach();

  // Discard the interpreter.
  if (this.JSInterpreter) {
    this.JSInterpreter.deinitialize();
    this.JSInterpreter = null;
    this.interpreterStarted = false;
  }
  this.executionError = null;

  // Soft buttons
  var softButtonCount = 0;
  for (var i = 0; i < this.level.softButtons.length; i++) {
    document.getElementById(this.level.softButtons[i]).style.display = 'inline';
    softButtonCount++;
  }
  if (softButtonCount) {
    $('#soft-buttons').removeClass('soft-buttons-none').addClass('soft-buttons-' + softButtonCount);
  }

  if (this.level.showDPad) {
    $('#studio-dpad').removeClass('studio-dpad-none');
    this.resetDPad();
  }
};

GameLab.prototype.onPuzzleComplete = function (submit) {
  if (this.executionError) {
    this.result = this.studioApp_.ResultType.ERROR;
  } else {
    // In most cases, submit all results as success
    this.result = this.studioApp_.ResultType.SUCCESS;
  }

  // If we know they succeeded, mark levelComplete true
  var levelComplete = (this.result === this.studioApp_.ResultType.SUCCESS);

  if (this.executionError) {
    this.testResults = this.studioApp_.getTestResults(levelComplete, {
        executionError: this.executionError
    });
  } else if (!submit) {
    this.testResults = this.studioApp_.TestResults.FREE_PLAY;
  }

  // Stop everything on screen
  this.reset();

  var program;
  var containedLevelResultsInfo = this.studioApp_.getContainedLevelResultsInfo();

  if (containedLevelResultsInfo) {
    // Keep our this.testResults as always passing so the feedback dialog
    // shows Continue (the proper results will be reported to the service)
    this.testResults = this.studioApp_.TestResults.ALL_PASS;
    this.message = containedLevelResultsInfo.feedback;
  } else {
    // If we want to "normalize" the JavaScript to avoid proliferation of nearly
    // identical versions of the code on the service, we could do either of these:

    // do an acorn.parse and then use escodegen to generate back a "clean" version
    // or minify (uglifyjs) and that or js-beautify to restore a "clean" version

    program = encodeURIComponent(this.studioApp_.getCode());
    this.message = null;
  }

  if (this.testResults >= this.studioApp_.TestResults.FREE_PLAY) {
    this.studioApp_.playAudio('win');
  } else {
    this.studioApp_.playAudio('failure');
  }

  this.waitingForReport = true;

  var sendReport = function () {
    this.studioApp_.report({
      app: 'gamelab',
      level: this.level.id,
      result: levelComplete,
      testResult: this.testResults,
      submitted: submit,
      program: program,
      image: this.encodedFeedbackImage,
      containedLevelResultsInfo: containedLevelResultsInfo,
      onComplete: (submit ? this.onSubmitComplete.bind(this) : this.onReportComplete.bind(this))
    });

    if (this.studioApp_.isUsingBlockly()) {
      // reenable toolbox
      Blockly.mainBlockSpaceEditor.setEnableToolbox(true);
    }
  }.bind(this);

  var divGameLab = document.getElementById('divGameLab');
  if (!divGameLab || typeof divGameLab.toDataURL === 'undefined') { // don't try it if function is not defined
    sendReport();
  } else {
    divGameLab.toDataURL("image/png", {
      callback: function (pngDataUrl) {
        this.feedbackImage = pngDataUrl;
        this.encodedFeedbackImage = encodeURIComponent(this.feedbackImage.split(',')[1]);

        sendReport();
      }.bind(this)
    });
  }
};

GameLab.prototype.onSubmitComplete = function (response) {
  window.location.href = response.redirect;
};

/**
 * Function to be called when the service report call is complete
 * @param {object} JSON response (if available)
 */
GameLab.prototype.onReportComplete = function (response) {
  this.response = response;
  this.waitingForReport = false;
  this.studioApp_.onReportComplete(response);
  this.displayFeedback_();
};

/**
 * Click the run button.  Start the program.
 */
GameLab.prototype.runButtonClick = function () {
  this.studioApp_.toggleRunReset('reset');
  // document.getElementById('spinner').style.visibility = 'visible';
  if (this.studioApp_.isUsingBlockly()) {
    Blockly.mainBlockSpace.traceOn(true);
  }
  this.studioApp_.attempts++;
  this.execute();

  // Enable the Finish button if is present:
  var shareCell = document.getElementById('share-cell');
  if (shareCell) {
    shareCell.className = 'share-cell-enabled';
  }
};

function p5KeyCodeFromArrow(idBtn) {
  switch (idBtn) {
    case ArrowIds.LEFT:
      return window.p5.prototype.LEFT_ARROW;
    case ArrowIds.RIGHT:
      return window.p5.prototype.RIGHT_ARROW;
    case ArrowIds.UP:
      return window.p5.prototype.UP_ARROW;
    case ArrowIds.DOWN:
      return window.p5.prototype.DOWN_ARROW;
  }
}

GameLab.prototype.onArrowButtonDown = function (buttonId, e) {
  // Store the most recent event type per-button
  this.btnState[buttonId] = ButtonState.DOWN;
  e.preventDefault();  // Stop normal events so we see mouseup later.

  this.gameLabP5.notifyKeyCodeDown(p5KeyCodeFromArrow(buttonId));
};

GameLab.prototype.onArrowButtonUp = function (buttonId, e) {
  // Store the most recent event type per-button
  this.btnState[buttonId] = ButtonState.UP;

  this.gameLabP5.notifyKeyCodeUp(p5KeyCodeFromArrow(buttonId));
};

GameLab.prototype.onDPadButtonDown = function (e) {
  this.dPadState = {};
  this.dPadState.boundHandler = this.onDPadMouseMove.bind(this);
  document.body.addEventListener('mousemove', this.dPadState.boundHandler);
  this.dPadState.touchEventName = dom.getTouchEventName('mousemove');
  if (this.dPadState.touchEventName) {
    document.body.addEventListener(this.dPadState.touchEventName,
        this.dPadState.boundHandler);
  }
  if (e.touches) {
    this.dPadState.startingX = e.touches[0].clientX;
    this.dPadState.startingY = e.touches[0].clientY;
    this.dPadState.previousX = e.touches[0].clientX;
    this.dPadState.previousY = e.touches[0].clientY;
  } else {
    this.dPadState.startingX = e.clientX;
    this.dPadState.startingY = e.clientY;
    this.dPadState.previousX = e.clientX;
    this.dPadState.previousY = e.clientY;
  }

  $('#studio-dpad-button').addClass('active');

  e.preventDefault();  // Stop normal events so we see mouseup later.
};

var DPAD_DEAD_ZONE = 3;

GameLab.prototype.onDPadMouseMove = function (e) {
  var dPadButton = $('#studio-dpad-button');
  var self = this;

  function notifyKeyHelper(keyCode, cssClass, start, prev, cur, invert) {
    if (invert) {
      start *= -1;
      prev *= -1;
      cur *= -1;
    }
    start -= DPAD_DEAD_ZONE;

    if (cur < start) {
      if (prev >= start) {
        self.gameLabP5.notifyKeyCodeDown(keyCode);
        dPadButton.addClass(cssClass);
      }
    } else if (prev < start) {
      self.gameLabP5.notifyKeyCodeUp(keyCode);
      dPadButton.removeClass(cssClass);
    }
  }

  var clientX = e.clientX;
  var clientY = e.clientY;
  if (e.touches) {
    clientX = e.touches[0].clientX;
    clientY = e.touches[0].clientY;
  }

  notifyKeyHelper(window.p5.prototype.LEFT_ARROW, 'left',
      this.dPadState.startingX, this.dPadState.previousX, clientX, false);
  notifyKeyHelper(window.p5.prototype.RIGHT_ARROW, 'right',
      this.dPadState.startingX, this.dPadState.previousX, clientX, true);
  notifyKeyHelper(window.p5.prototype.UP_ARROW, 'up',
      this.dPadState.startingY, this.dPadState.previousY, clientY, false);
  notifyKeyHelper(window.p5.prototype.DOWN_ARROW, 'down',
      this.dPadState.startingY, this.dPadState.previousY, clientY, true);

  this.dPadState.previousX = clientX;
  this.dPadState.previousY = clientY;
};

GameLab.prototype.resetDPad = function () {
  if (this.dPadState.boundHandler) {
    // Fake a final mousemove back at the original starting position, which
    // will reset buttons back to "up":
    this.onDPadMouseMove({
      clientX: this.dPadState.startingX,
      clientY: this.dPadState.startingY,
    });

    document.body.removeEventListener('mousemove', this.dPadState.boundHandler);
    if (this.dPadState.touchEventName) {
      document.body.removeEventListener(this.dPadState.touchEventName,
          this.dPadState.boundHandler);
    }

    $('#studio-dpad-button').removeClass('active');

    this.dPadState = {};
  }
};

GameLab.prototype.onMouseUp = function (e) {
  // Reset all arrow buttons on "global mouse up" - this handles the case where
  // the mouse moved off the arrow button and was released somewhere else
  for (var buttonId in this.btnState) {
    if (this.btnState[buttonId] === ButtonState.DOWN) {

      this.btnState[buttonId] = ButtonState.UP;
      this.gameLabP5.notifyKeyCodeUp(p5KeyCodeFromArrow(buttonId));
    }
  }

  this.resetDPad();
};

/**
 * Execute the user's code.  Heaven help us...
 */
GameLab.prototype.execute = function () {
  this.result = this.studioApp_.ResultType.UNSET;
  this.testResults = this.studioApp_.TestResults.NO_TESTS_RUN;
  this.waitingForReport = false;
  this.response = null;

  // Reset all state.
  this.studioApp_.reset();
  this.studioApp_.clearAndAttachRuntimeAnnotations();

  if (this.studioApp_.isUsingBlockly() &&
      (this.studioApp_.hasUnwantedExtraTopBlocks() ||
        this.studioApp_.hasDuplicateVariablesInForLoops())) {
    // immediately check answer, which will fail and report top level blocks
    this.onPuzzleComplete();
    return;
  }

  this.gameLabP5.startExecution();

  if (!this.JSInterpreter ||
      !this.JSInterpreter.initialized() ||
      this.executionError) {
    return;
  }

  this.studioApp_.playAudio('start');

  if (this.studioApp_.isUsingBlockly()) {
    // Disable toolbox while running
    Blockly.mainBlockSpaceEditor.setEnableToolbox(false);
  }

  // Set to 1ms interval, but note that browser minimums are actually 5-16ms:
  this.tickIntervalId = window.setInterval(this.onTick.bind(this), 1);
};

GameLab.prototype.initInterpreter = function () {
  codegen.customMarshalObjectList = this.gameLabP5.getCustomMarshalObjectList();

  var self = this;
  function injectGamelabGlobals() {
    var propList = self.gameLabP5.getGlobalPropertyList();
    for (var prop in propList) {
      // Each entry in the propList is an array with 2 elements:
      // propListItem[0] - a native property value
      // propListItem[1] - the property's parent object
      self.JSInterpreter.createGlobalProperty(
          prop,
          propList[prop][0],
          propList[prop][1]);
    }
  }

  this.JSInterpreter = new JSInterpreter({
    studioApp: this.studioApp_,
    maxInterpreterStepsPerTick: MAX_INTERPRETER_STEPS_PER_TICK,
    customMarshalGlobalProperties: this.gameLabP5.getCustomMarshalGlobalProperties(),
    customMarshalBlockedProperties: this.gameLabP5.getCustomMarshalBlockedProperties()
  });
  this.JSInterpreter.onExecutionError.register(this.handleExecutionError.bind(this));
  this.consoleLogger_.attachTo(this.JSInterpreter);
  if (this.debugger_) {
    this.debugger_.attachTo(this.JSInterpreter);
  }
  this.JSInterpreter.parse({
    code: this.studioApp_.getCode(),
    blocks: dropletConfig.blocks,
    blockFilter: this.level.executePaletteApisOnly && this.level.codeFunctions,
    enableEvents: true,
    initGlobals: injectGamelabGlobals
  });
  if (!this.JSInterpreter.initialized()) {
    return;
  }

  gameLabSprite.injectJSInterpreter(this.JSInterpreter);
  gameLabGroup.injectJSInterpreter(this.JSInterpreter);

  this.gameLabP5.p5specialFunctions.forEach(function (eventName) {
    var func = this.JSInterpreter.findGlobalFunction(eventName);
    if (func) {
      this.eventHandlers[eventName] =
          codegen.createNativeFunctionFromInterpreterFunction(func);
    }
  }, this);

  this.globalCodeRunsDuringPreload = !!this.eventHandlers.setup;

  /*
  if (this.checkForEditCodePreExecutionFailure()) {
   return this.onPuzzleComplete();
  }
  */
};

GameLab.prototype.onTick = function () {
  this.tickCount++;

  if (this.JSInterpreter) {
    if (this.interpreterStarted) {
      this.JSInterpreter.executeInterpreter();
    }

    this.completePreloadIfPreloadComplete();
    this.completeSetupIfSetupComplete();
    this.completeRedrawIfDrawComplete();
  }
};

/**
 * This is called while this.gameLabP5 is in startExecution(). We use the
 * opportunity to create native event handlers that call down into interpreter
 * code for each event name.
 */
GameLab.prototype.onP5ExecutionStarting = function () {
  this.gameLabP5.p5eventNames.forEach(function (eventName) {
    this.gameLabP5.registerP5EventHandler(eventName, function () {
      if (this.JSInterpreter && this.eventHandlers[eventName]) {
        this.eventHandlers[eventName].apply(null);
      }
    }.bind(this));
  }, this);
};

/**
 * This is called while this.gameLabP5 is in the preload phase. Do the following:
 *
 * - load animations into the P5 engine
 * - initialize the interpreter
 * - start its execution
 * - (optional) execute global code
 * - call the user's preload function
 *
 * @return {Boolean} FALSE so that P5 will internally increment a preload count;
 *         calling notifyPreloadPhaseComplete is then necessary to continue
 *         loading the game.
 */
GameLab.prototype.onP5Preload = function () {
  Promise.all([
      this.preloadAnimations_(),
      this.runPreloadEventHandler_()
  ]).then(() => {
    this.gameLabP5.notifyPreloadPhaseComplete();
  });
  return false;
};

/**
 * Wait for animations to be loaded into memory and ready to use, then pass
 * those animations to P5 to be loaded into the engine as animations.
 * @returns {Promise} which resolves once animations are in memory in the redux
 *          store and we've started loading them into P5.
 *          Loading to P5 is also an async process but it has its own internal
 *          effect on the P5 preloadCount, so we don't need to track it here.
 * @private
 */
GameLab.prototype.preloadAnimations_ = function () {
  let store = this.studioApp_.reduxStore;
  return new Promise(resolve => {
    if (this.areAnimationsReady_()) {
      resolve();
    } else {
      // Watch store changes until all the animations are ready.
      const unsubscribe = store.subscribe(() => {
        if (this.areAnimationsReady_()) {
          unsubscribe();
          resolve();
        }
      });
    }
  }).then(() => {
    // Animations are ready - send them to p5 to be loaded into the engine.
    this.gameLabP5.preloadAnimations(store.getState().animationList);
  });
};

/**
 * Check whether all animations in the project animation list have been loaded
 * into memory and are ready to use.
 * @returns {boolean}
 * @private
 */
GameLab.prototype.areAnimationsReady_ = function () {
  const animationList = this.studioApp_.reduxStore.getState().animationList;
  return animationList.orderedKeys.every(key => animationList.propsByKey[key].loadedFromSource);
};

/**
 * Run the preload event handler, and optionally global code, and report when
 * it is done by resolving a returned Promise.
 * @returns {Promise} Which will resolve immediately if there is no code to run,
 *          otherwise will resolve when the preload handler has completed.
 * @private
 */
GameLab.prototype.runPreloadEventHandler_ = function () {
  return new Promise(resolve => {
    this.initInterpreter();
    // Execute the interpreter for the first time:
    if (this.JSInterpreter && this.JSInterpreter.initialized()) {
      // Start executing the interpreter's global code as long as a setup() method
      // was provided. If not, we will skip running any interpreted code in the
      // preload phase and wait until the setup phase.
      this.reportPreloadEventHandlerComplete_ = () => {
        this.reportPreloadEventHandlerComplete_ = null;
        resolve();
      };
      if (this.globalCodeRunsDuringPreload) {
        this.JSInterpreter.executeInterpreter(true);
        this.interpreterStarted = true;

        // In addition, execute the global function called preload()
        if (this.eventHandlers.preload) {
          this.eventHandlers.preload.apply(null);
        }
      } else {
        if (this.eventHandlers.preload) {
          this.log("WARNING: preload() was ignored because setup() was not provided");
          this.eventHandlers.preload = null;
        }
      }
      this.completePreloadIfPreloadComplete();
    } else {
      // If we didn't run anything resolve now.
      resolve();
    }
  });
};

/**
 * Called on tick to check whether preload code is done running, and trigger
 * the appropriate report of completion if it is.
 */
GameLab.prototype.completePreloadIfPreloadComplete = function () {
  // This function will have been created in runPreloadEventHandler if we
  // actually had an interpreter and might have run preload code.  It could
  // be null if we didn't have an interpreter, or we've already called it.
  if (typeof this.reportPreloadEventHandlerComplete_ !== 'function') {
    return;
  }

  if (this.globalCodeRunsDuringPreload &&
      !this.JSInterpreter.startedHandlingEvents) {
    // Global code should run during the preload phase, but global code hasn't
    // completed.
    return;
  }

  if (!this.eventHandlers.preload ||
      this.JSInterpreter.seenReturnFromCallbackDuringExecution) {
    this.reportPreloadEventHandlerComplete_();
  }
};

/**
 * This is called while this.gameLabP5 is in the setup phase. We restore the
 * interpreter methods that were modified during preload, then call the user's
 * setup function.
 */
GameLab.prototype.onP5Setup = function () {
  if (this.JSInterpreter) {
    // Re-marshal restored preload methods for the interpreter:
    for (var method in this.gameLabP5.p5._preloadMethods) {
      this.JSInterpreter.createGlobalProperty(
          method,
          this.gameLabP5.p5[method],
          this.gameLabP5.p5);
    }

    this.setupInProgress = true;
    if (!this.globalCodeRunsDuringPreload) {
      // If the setup() method was not provided, we need to run the interpreter
      // for the first time at this point:
      this.JSInterpreter.executeInterpreter(true);
      this.interpreterStarted = true;
    }
    if (this.eventHandlers.setup) {
      this.eventHandlers.setup.apply(null);
    }
    this.completeSetupIfSetupComplete();
  }
};

GameLab.prototype.completeSetupIfSetupComplete = function () {
  if (!this.setupInProgress) {
    return;
  }

  if (!this.globalCodeRunsDuringPreload &&
      !this.JSInterpreter.startedHandlingEvents) {
    // Global code should run during the setup phase, but global code hasn't
    // completed.
    return;
  }

  if (!this.eventHandlers.setup ||
      this.JSInterpreter.seenReturnFromCallbackDuringExecution) {
    this.gameLabP5.afterSetupComplete();
    this.setupInProgress = false;
  }
};

/**
 * This is called while this.gameLabP5 is in a draw() call. We call the user's
 * draw function.
 */
GameLab.prototype.onP5Draw = function () {
  if (this.JSInterpreter && this.eventHandlers.draw) {
    this.drawInProgress = true;
    this.eventHandlers.draw.apply(null);
  }
  this.completeRedrawIfDrawComplete();
};

GameLab.prototype.completeRedrawIfDrawComplete = function () {
  if (this.drawInProgress && this.JSInterpreter.seenReturnFromCallbackDuringExecution) {
    this.gameLabP5.afterDrawComplete();
    this.drawInProgress = false;
    $('#bubble').text('FPS: ' + this.gameLabP5.getFrameRate().toFixed(0));
  }
};

GameLab.prototype.handleExecutionError = function (err, lineNumber) {
  outputError(String(err), ErrorLevel.ERROR, lineNumber);
  this.executionError = { err: err, lineNumber: lineNumber };
  this.haltExecution_();
  // TODO: Call onPuzzleComplete?
};

/**
 * Executes an API command.
 */
GameLab.prototype.executeCmd = function (id, name, opts) {
  var retVal = false;
  if (gamelabCommands[name] instanceof Function) {
    retVal = gamelabCommands[name](opts);
  }
  return retVal;
};

/**
 * App specific displayFeedback function that calls into
 * this.studioApp_.displayFeedback when appropriate
 */
GameLab.prototype.displayFeedback_ = function () {
  var level = this.level;

  this.studioApp_.displayFeedback({
    app: 'gamelab',
    skin: this.skin.id,
    feedbackType: this.testResults,
    message: this.message,
    response: this.response,
    level: level,
    // feedbackImage: feedbackImageCanvas.canvas.toDataURL("image/png"),
    // add 'impressive':true to non-freeplay levels that we deem are relatively impressive (see #66990480)
    showingSharing: !level.disableSharing && (level.freePlay /* || level.impressive */),
    // impressive levels are already saved
    // alreadySaved: level.impressive,
    // allow users to save freeplay levels to their gallery (impressive non-freeplay levels are autosaved)
    saveToGalleryUrl: level.freePlay && this.response && this.response.save_to_gallery_url,
    appStrings: {
      reinfFeedbackMsg: msg.reinfFeedbackMsg(),
      sharingText: msg.shareGame()
    }
  });
};

/**
 * Get the project's animation metadata for upload to the sources API.
 * Bound to appOptions in gamelab/main.js, used in project.js for autosave.
 * @return {AnimationList}
 */
GameLab.prototype.getSerializedAnimationList = function (callback) {
  this.studioApp_.reduxStore.dispatch(saveAnimations(() => {
    callback(getSerializedAnimationList(this.studioApp_.reduxStore.getState().animationList));
  }));
};

GameLab.prototype.getAnimationDropdown = function () {
  const animationList = this.studioApp_.reduxStore.getState().animationList;
  return animationList.orderedKeys.map(key => {
    const name = animationList.propsByKey[key].name;
    return {
      text: utils.quote(name),
      display: utils.quote(name)
    };
  });
};

GameLab.prototype.getAppReducers = function () {
  return reducers;
};
