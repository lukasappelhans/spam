! function() {
    "use strict";

    if (typeof module !== 'undefined') {
        var d3 = require('d3'),
            topojson = require('topojson'),
            rbush = require('rbush')
    } else {
        var d3 = window.d3,
            topojson = window.topojson,
            rbush = window.rbush
    }

    // TODO use turf inside as a dependency?
    // Copied from turf.inside
    function inside(pt, polygon) {
        var polys = polygon.geometry.coordinates
        // normalize to multipolygon
        if (polygon.geometry.type === 'Polygon')
            polys = [polys]

        var insidePoly = false
        var i = 0
        while (i < polys.length && !insidePoly) {
            // check if it is in the outer ring first
            if (inRing(pt, polys[i][0])) {
                var inHole = false
                var k = 1
                // check for the point in any of the holes
                while (k < polys[i].length && !inHole) {
                    if (inRing(pt, polys[i][k])) {
                        inHole = true
                    }
                    k++
                }
                if(!inHole)
                    insidePoly = true
            }
            i++
        }
        return insidePoly
    }

    // pt is [x,y] and ring is [[x,y], [x,y],..]
    function inRing (pt, ring) {
        var isInside = false
        for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            var xi = ring[i][0], yi = ring[i][1]
            var xj = ring[j][0], yj = ring[j][1]
            var intersect = ((yi > pt[1]) !== (yj > pt[1])) &&
                (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)
            if (intersect) isInside = !isInside
        }
        return isInside
    }

    function maxBounds(one, two) {
        var bounds = two
        bounds[0][0] = Math.min(one[0][0], two[0][0])
        bounds[0][1] = Math.min(one[0][1], two[0][1])
        bounds[1][0] = Math.max(one[1][0], two[1][0])
        bounds[1][1] = Math.max(one[1][1], two[1][1])
        return bounds
    }

    function createRTree(element, dataPath) {
        element.lookupTree = rbush(4)
        var elements = []

        for (var j in element.features.features) {
            var bounds = dataPath.bounds(element.features.features[j])
            elements.push({
                minX: Math.floor(bounds[0][0]),
                minY: Math.floor(bounds[0][1]),
                maxX: Math.ceil(bounds[1][0]),
                maxY: Math.ceil(bounds[1][1]),
                polygon: element.features.features[j]
            })
        }
        element.lookupTree.load(elements)
    }

    function createRTrees(data, dataPath) {
        for (var i in data) {
            data[i].lookupTree || createRTree(data[i], dataPath)
        }
    }

    function paintFeature(element, feature, parameters) {
        parameters.context.beginPath()
        parameters.path(feature)
        element.static.paintfeature(parameters, feature)
    }

    function paintBackgroundElement(element, parameters) {
        if (!element.static)
            return
        element.static.prepaint && element.static.prepaint(parameters)
        if (element.static.paintfeature) {
            for (var j in element.features.features) {
                paintFeature(element, element.features.features[j], parameters)
            }
        }
        element.static.postpaint && element.static.postpaint(parameters)
    }

    function PartialPainter(data, parameters) {
        var index = 0,
            j = 0,
            element = data[index],
            currentLookup = element.lookupTree.search({
                minX: - parameters.translate[0],
                minY: - parameters.translate[1],
                maxX: parameters.width / parameters.scale / parameters.projectedScale - parameters.translate[0],
                maxY: parameters.height / parameters.scale / parameters.projectedScale - parameters.translate[1]
            })

        function selectNextIndex() {
            index++
            while (index < data.length && !data[index].static) {
                index++
            }
            if (index >= data.length)
                return false
            element = data[index]
            currentLookup = element.lookupTree.search({
                minX: - parameters.translate[0],
                minY: - parameters.translate[1],
                maxX: parameters.width / parameters.scale / parameters.projectedScale - parameters.translate[0],
                maxY: parameters.height / parameters.scale / parameters.projectedScale - parameters.translate[1]
            })
            j = 0
            return true
        }

        this.hasNext = function() {
            return index < data.length && j < currentLookup.length
        }
        this.renderNext = function() {
            if (!this.hasNext())
                return
            var start = performance.now()
            j >= currentLookup.length && selectNextIndex()

            !j && element.static.prepaint && element.static.prepaint(parameters)

            !element.static.paintfeature && (j = currentLookup.length)

            for (; j != currentLookup.length; ++j) {
                paintFeature(element, currentLookup[j].polygon, parameters)
                if ((performance.now() - start) > 10)
                    return
            }
            element.static.postpaint && element.static.postpaint(parameters)
        }
        this.finish = function() {
            if (j < currentLookup.length) {
                if (element.static.paintfeature) {
                    for (; j != currentLookup.length; ++j) {
                        paintFeature(element, currentLookup[j].polygon, parameters)
                    }
                }
                element.static.postpaint && element.static.postpaint(parameters)
            }
            while (selectNextIndex()) {
                element.static.prepaint && element.static.prepaint(parameters)
                if (element.static.paintfeature) {
                    for (; j != currentLookup.length; ++j) {
                        paintFeature(element, currentLookup[j].polygon, parameters)
                    }
                }
                element.static.postpaint && element.static.postpaint(parameters)
            }
        }
    }

    function translatePoint(point, scale, translate) {
        return [
            point[0] / scale - translate[0],
            point[1] / scale - translate[1]
        ]
    }

    function extend(extension, obj) {
        var newObj = {}
        // FIXME this is a bit hacky? Can't we just mutate the original obj? (can't bc projection)
        for (var elem in obj) {
            newObj[elem] = obj[elem]
        }
        for (var elem in extension) {
            if (!newObj.hasOwnProperty(elem))
                newObj[elem] = extension[elem]
        }
        return newObj
    }

    function CanvasMap(parameters) {
        var settings = extend({
                width: d3.select(parameters.element).node().getBoundingClientRect().width,
                ratio: 1,
                area: 0,
                scale: 1,
                projectedScale: 1,
                translate: [0, 0],
                background: null,
                backgroundScale: 1,
                backgroundTranslate: [0, 0],
                map: this
            }, parameters),
            simplify = d3.geoTransform({
                point: function(x, y, z) {
                    if (!z || z >= settings.area) {
                        this.stream.point(x, y)
                    }
                }
            }),
            canvas = null,
            context = null

        if (!parameters.hasOwnProperty("projection")) {
            var b = [[Infinity, Infinity],
                     [-Infinity, -Infinity]]
            for (var i in settings.data) {
                b = maxBounds(b, d3.geoBounds(settings.data[i].features))
            }
            settings.projection = d3.geoMercator()
                .scale(1)
                .center([(b[1][0] + b[0][0]) / 2, (b[1][1] + b[0][1]) / 2])
        }
        var dataPath = d3.geoPath().projection({
            stream: function(s) {
                if (settings.projection)
                    return simplify.stream(settings.projection.stream(s))
                return simplify.stream(s)
            }
        })
        var b = [[Infinity, Infinity],
                 [-Infinity, -Infinity]]
        for (var i in settings.data) {
            b = maxBounds(b, dataPath.bounds(settings.data[i].features))
        }

        var dx = b[1][0] - b[0][0],
            dy = b[1][1] - b[0][1]

        if (!settings.projection) {
            settings.projectedScale = settings.width / b[1][0]
        }

        if (!parameters.hasOwnProperty("projection")) {
            settings.height = settings.height || Math.ceil(dy * settings.width / dx)
            settings.projection.scale(0.9 * (settings.width / dx))
                .translate([settings.width / 2, settings.height / 2])
        } else if (!settings.projected) {
            settings.height = Math.ceil(b[1][1] * settings.projectedScale)
        } else if (!settings.height) {
            settings.height = Math.ceil(dy / 0.9)
        }
        d3.select(settings.parameters).attr("height", settings.height)

        function init() {
            canvas = d3.select(settings.element)
                .append("canvas")
            context = canvas.node().getContext("2d")

            var devicePixelRatio = window.devicePixelRatio || 1,
                backingStoreRatio = context.webkitBackingStorePixelRatio ||
                                    context.mozBackingStorePixelRatio ||
                                    context.msBackingStorePixelRatio ||
                                    context.oBackingStorePixelRatio ||
                                    context.backingStorePixelRatio || 1

            settings.ratio = devicePixelRatio / backingStoreRatio * settings.projectedScale
            settings.area = 1 / settings.ratio
            if (settings.projection)
                settings.area = settings.area / settings.projection.scale() / 25

            canvas.attr("width", settings.width / settings.projectedScale * settings.ratio)
            canvas.attr("height", settings.height / settings.projectedScale * settings.ratio)
            canvas.style("width", settings.width + "px")
            canvas.style("height", settings.height + "px")
            context.lineJoin = "round"
            context.lineCap = "round"

            dataPath.context(context)
            context.clearRect(0, 0, settings.width * settings.ratio, settings.height * settings.ratio)
            context.save()
            context.scale(settings.ratio, settings.ratio)

            var hasHover = false,
                hasClick = false
            for (var i in settings.data) {
                var element = settings.data[i]

                hasHover = hasHover || (element.events && element.events.hover)
                hasClick = hasClick || (element.events && element.events.click)
            }

            // Only compute rtrees if we need it for event handling
            if (hasHover || hasClick) {
                createRTrees(settings.data, dataPath)
            }

            settings.background = new Image()
            settings.backgroundScale = settings.scale
            settings.backgroundTranslate = settings.translate
            var parameters = {
                path: dataPath,
                context: context,
                scale: settings.scale,
                translate: settings.translate,
                width: settings.width,
                height: settings.height,
                map: settings.map,
                projection: settings.projection,
                projectedScale: settings.projectedScale
            }
            var callback = function() {
                context.restore()

                hasClick && canvas.on("click", click)
                hasHover && canvas.on("mousemove", hover)
                                  .on("mouseleave", hoverLeave)

                paint() // For dynamic paints
            }

            for (var i in settings.data) {
                var element = settings.data[i]
                paintBackgroundElement(element, parameters)
            }
            settings.background.onload = callback
            settings.background.src = canvas.node().toDataURL()

            //Prevent another call to the init method
            this.init = function() {}
        }

        function paint() {
            context.save()
            context.scale(settings.scale * settings.ratio, settings.scale * settings.ratio)
            context.translate(settings.translate[0], settings.translate[1])

            context.clearRect(-settings.translate[0], -settings.translate[1],
                settings.width * settings.ratio / settings.projectedScale,
                settings.height * settings.ratio / settings.projectedScale)

            context.rect(-settings.translate[0], -settings.translate[1],
                settings.width / settings.scale / settings.projectedScale,
                settings.height / settings.scale / settings.projectedScale)
            context.clip()

            // FIXME this needs a way for the callback to use the lookupTree?
            var parameters = {
                path: dataPath,
                context: dataPath.context(),
                scale: settings.scale,
                translate: settings.translate,
                width: settings.width,
                height: settings.height,
                map: settings.map,
                projection: settings.projection,
                projectedScale: settings.projectedScale
            }

            settings.area = 1 / settings.scale / settings.ratio
            if (settings.projection)
                settings.area = settings.area / settings.projection.scale() / 25

            for (var i in settings.data) {
                var element = settings.data[i]
                if (element.dynamic && element.dynamic.prepaint)
                    element.dynamic.prepaint(parameters, element.hoverElement)
            }

            context.drawImage(settings.background, 0, 0,
                settings.width * settings.ratio / settings.projectedScale,
                settings.height * settings.ratio / settings.projectedScale,
                - settings.backgroundTranslate[0],
                - settings.backgroundTranslate[1],
                settings.width / settings.backgroundScale / settings.projectedScale,
                settings.height / settings.backgroundScale / settings.projectedScale)

            for (var i in settings.data) {
                var element = settings.data[i]
                if (element.dynamic && element.dynamic.postpaint)
                    element.dynamic.postpaint(parameters, element.hoverElement)
            }

            context.restore()
        }

        function click() {
            var point = translatePoint(d3.mouse(this), settings.scale * settings.projectedScale, settings.translate),
                topojsonPoint = settings.projection ? settings.projection.invert(point) : point

            var parameters = {
                scale: settings.scale,
                translate: settings.translate,
                width: settings.width,
                height: settings.height,
                map: settings.map,
                projection: settings.projection,
                projectedScale: settings.projectedScale
            }
            for (var i in settings.data) {
                var element = settings.data[i]
                if (!element.events || !element.events.click)
                    continue

                var lookup = element.lookupTree.search({
                    minX: point[0],
                    minY: point[1],
                    maxX: point[0],
                    maxY: point[1]
                })
                var isInside = false
                for (var j in lookup) {
                    var feature = lookup[j].polygon
                    if (inside(topojsonPoint, feature)) {
                        element.events.click(parameters, feature)
                        isInside = true
                    }
                }
                isInside || element.events.click(parameters, null)
            }
        }

        function hoverLeave() {
            var parameters = {
                scale: settings.scale,
                translate: settings.translate,
                width: settings.width,
                height: settings.height,
                map: settings.map,
                projection: settings.projection,
                projectedScale: settings.projectedScale
            }
            for (var i in settings.data) {
                var element = settings.data[i]
                if (!element.events || !element.events.hover)
                    continue
                element.hoverElement = false
                element.events.hover(parameters, null)
            }
        }

        function hover() {
            var point = translatePoint(d3.mouse(this), settings.scale * settings.projectedScale, settings.translate),
                parameters = {
                    scale: settings.scale,
                    translate: settings.translate,
                    width: settings.width,
                    height: settings.height,
                    map: settings.map,
                    projection: settings.projection,
                    projectedScale: settings.projectedScale
                },
                topojsonPoint = settings.projection ? settings.projection.invert(point) : point

            for (var i in settings.data) {
                var element = settings.data[i]
                if (!element.events || !element.events.hover ||
                    (element.hoverElement && inside(topojsonPoint, element.hoverElement))) {
                    continue
                }
                element.hoverElement = false
                var lookup = element.lookupTree.search({
                    minX: point[0],
                    minY: point[1],
                    maxX: point[0],
                    maxY: point[1]
                })
                for (var j in lookup) {
                    var feature = lookup[j].polygon
                    if (inside(topojsonPoint, feature)) {
                        element.hoverElement = feature
                        break
                    }
                }
                element.events.hover(parameters, element.hoverElement)
            }
        }

        this.init = init
        this.paint = paint
        this.settings = function() {
            return settings
        }
    }

    function StaticCanvasMap(parameters) {
        var map = new CanvasMap(parameters)

        this.init = function() {
            map.init()
        }
        this.paint = function() {
            map.paint()
        }
    }

    var epsilon = 0.5
    function nearEqual(a, b) {
        return Math.abs(a - b) < epsilon
    }

    function ImageCache(parameters) {
        var cache = [],
            settings = parameters

        this.addImage = function(parameters) {
            cache.push(parameters)
        }

        this.getImage = function(parameters) {
            for (var i in cache) {
                var element = cache[i]
                if (nearEqual(element.scale, parameters.scale) &&
                    nearEqual(element.translate[0], parameters.translate[0]) &&
                    nearEqual(element.translate[1], parameters.translate[1]))
                    return element
            }
            return null
        }

        this.getFittingImage = function(bbox) {
            // Auto set scale=1, translate[0, 0] image as default return
            var currentImage = cache.length > 0 ? cache[0] : null
            for (var i in cache) {
                var image = cache[i],
                    imageBB = [
                        - image.translate[0],
                        - image.translate[1],
                        settings.width / image.scale - image.translate[0],
                        settings.height / image.scale - image.translate[1]
                    ]
                if (imageBB[0] <= bbox[0] &&
                    imageBB[1] <= bbox[1] &&
                    imageBB[2] >= bbox[2] &&
                    imageBB[3] >= bbox[3] &&
                    (!currentImage || currentImage.scale < image.scale)) {
                    currentImage = image
                }
            }
            return currentImage
        }
    }

    function ZoomableCanvasMap(parameters) {
        var map = new CanvasMap(parameters),
            simplify = d3.geoTransform({
                point: function(x, y, z) {
                    if (!z || z >= area) this.stream.point(x, y)
                }
            }),
            area = 0,
            canvas = null,
            context = null,
            settings = map.settings(),
            dataPath = d3.geoPath().projection({
                stream: function(s) {
                    if (settings.projection)
                        return simplify.stream(settings.projection.stream(s))
                    return simplify.stream(s)
                }
            }),
            imageCache = new ImageCache({
                width: settings.width,
                height: settings.height
            }),
            busy = false

        settings.map = this
        settings.zoomScale = settings.zoomScale || 0.5

        this.init = function() {
            map.init()

            canvas = d3.select(settings.element).append("canvas")
            context = canvas.node().getContext("2d")
            area = 1 / settings.ratio
            if (settings.projection)
                area = area / settings.projection.scale() / 25

            canvas.attr("width", settings.width * settings.ratio / settings.projectedScale)
            canvas.attr("height", settings.height * settings.ratio / settings.projectedScale)
            canvas.style("width", settings.width + "px")
            canvas.style("height", settings.height + "px")
            canvas.style("display", "none")
            context.lineJoin = "round"
            context.lineCap = "round"

            dataPath.context(context)

            imageCache.addImage({
                image: settings.background,
                scale: settings.scale,
                translate: settings.translate
            })

            createRTrees(settings.data, dataPath)
        }
        this.paint = function() {
            map.paint()
        }
        function scaleZoom(scale, translate) {
            // We can just mutex with a standard variable, because JS is single threaded, yay!
            // The mutex is needed not to start multiple d3 transitions.
            if (busy) {
                return
            }
            busy = true
            if (nearEqual(scale, settings.scale) &&
                nearEqual(translate[0], settings.translate[0]) &&
                nearEqual(translate[1], settings.translate[1])) {
                scale = 1
                translate = [0, 0]
            }
            if (scale == 1 && settings.scale == 1 &&
                !translate[0] && !translate[1] &&
                !settings.translate[0] && !settings.translate[1]) {
                busy = false
                return
            }
            area = 1 / scale / settings.ratio
            if (settings.projection)
                area = area / settings.projection.scale() / 25

            context.save()
            context.scale(scale * settings.ratio, scale * settings.ratio)
            context.translate(translate[0], translate[1])
            context.clearRect(- translate[0], - translate[1],
                settings.width * settings.ratio / settings.projectedScale,
                settings.height * settings.ratio / settings.projectedScale)
            var parameters = {
                path: dataPath,
                context: context,
                scale: scale,
                projectedScale: settings.projectedScale,
                translate: translate,
                width: settings.width,
                height: settings.height,
                map: settings.map,
                projection: settings.projection,
                projectedScale: settings.projectedScale
            }

            var image = imageCache.getImage({
                scale: scale,
                translate: translate
            })
            if (!image) {
                var partialPainter = new PartialPainter(settings.data, parameters)
            }

            var translatedOne = translatePoint([settings.width, settings.height], scale, translate),
                translatedTwo = translatePoint([settings.width, settings.height], settings.scale, settings.translate)
            var bbox = [
                Math.min(- translate[0], - settings.translate[0]),
                Math.min(- translate[1], - settings.translate[1]),
                Math.max(translatedOne[0], translatedTwo[0]),
                Math.max(translatedOne[1], translatedTwo[1])
            ]
            var zoomImage = imageCache.getFittingImage(bbox)
            if (zoomImage) {
                settings.background = zoomImage.image
                settings.backgroundScale = zoomImage.scale
                settings.backgroundTranslate = zoomImage.translate
            }
            d3.transition()
                .duration(300)
                .ease(d3.easeLinear)
                .tween("zoom", function() {
                    var i = d3.interpolateNumber(settings.scale, scale),
                        oldTranslate = settings.translate,
                        oldScale = settings.scale
                    return function(t) {
                        settings.scale = i(t)
                        settings.translate = [
                            oldTranslate[0] + (translate[0] - oldTranslate[0]) / (scale - oldScale) * (i(t) - oldScale) * scale / i(t),
                            oldTranslate[1] + (translate[1] - oldTranslate[1]) / (scale - oldScale) * (i(t) - oldScale) * scale / i(t),
                        ]
                        map.paint()
                        !image && partialPainter.renderNext()
                    }
                })
                .on("end", function() {
                    settings.scale = scale
                    settings.translate = translate

                    if (image) {
                        context.restore()
                        settings.background = image.image
                        settings.backgroundScale = image.scale
                        settings.backgroundTranslate = image.translate
                        map.paint()
                    } else {
                        map.paint()
                        partialPainter.finish()

                        var background = new Image()
                        background.onload = function() {
                            context.restore()
                            imageCache.addImage({
                                image: background,
                                scale: scale,
                                translate: translate
                            })
                            settings.background = background
                            settings.backgroundScale = scale
                            settings.backgroundTranslate = translate
                            map.paint()
                        }
                        // TODO there is a function to get the image data from the context, is that faster?
                        // TODO use getImageData/putImageData, because it's faster?
                        background.src = canvas.node().toDataURL()
                    }
                    busy = false
                })
        }
        this.zoom = function(d) {
            if (!d) {
                scaleZoom.call(this, 1, [0, 0])
                return
            }
            var bounds = dataPath.bounds(d),
                dx = bounds[1][0] - bounds[0][0],
                dy = bounds[1][1] - bounds[0][1],
                bx = (bounds[0][0] + bounds[1][0]) / 2,
                by = (bounds[0][1] + bounds[1][1]) / 2,
                scale = settings.zoomScale / settings.projectedScale *
                    Math.min(settings.width / dx, settings.height / dy),
                translate = [-bx + settings.width / settings.projectedScale / scale / 2,
                             -by + settings.height / settings.projectedScale / scale / 2]

            scaleZoom.call(this, scale, translate)
        }
    }
    if (typeof module !== 'undefined') {
        module.exports = {
            StaticCanvasMap: StaticCanvasMap,
            ZoomableCanvasMap: ZoomableCanvasMap
        }
    } else {
        window.StaticCanvasMap = StaticCanvasMap
        window.ZoomableCanvasMap = ZoomableCanvasMap
    }
}()
