/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { effectiveDependencies, generateRos2Package, isValidRos2PackageName, ros2Extras, ros2PkgCreateArgs } from '../modes/ros2/generator';

suite('ROS2 generator', () => {

	test('package name validation', () => {
		assert.ok(isValidRos2PackageName('my_robot_driver'));
		assert.ok(!isValidRos2PackageName('MyRobot'));
		assert.ok(!isValidRos2PackageName('my__robot'));
		assert.ok(!isValidRos2PackageName('robot_'));
		assert.ok(!isValidRos2PackageName('1robot'));
	});

	test('ros2 pkg create arguments per build type', () => {
		assert.deepStrictEqual(ros2PkgCreateArgs({ name: 'cpp_pkg', buildType: 'ament_cmake', dependencies: ['std_msgs'] }),
			['pkg', 'create', 'cpp_pkg', '--license', 'Apache-2.0', '--build-type', 'ament_cmake', '--node-name', 'cpp_pkg_node', '--dependencies', 'std_msgs', 'rclcpp']);
		assert.deepStrictEqual(ros2PkgCreateArgs({ name: 'py_pkg', buildType: 'ament_python', dependencies: [], nodeName: 'talker' }),
			['pkg', 'create', 'py_pkg', '--license', 'Apache-2.0', '--build-type', 'ament_python', '--node-name', 'talker', '--dependencies', 'rclpy']);
		assert.deepStrictEqual(ros2PkgCreateArgs({ name: 'lib_pkg', buildType: 'ament_cmake_library', dependencies: ['geometry_msgs'] }),
			['pkg', 'create', 'lib_pkg', '--license', 'Apache-2.0', '--build-type', 'ament_cmake', '--library-name', 'lib_pkg', '--dependencies', 'geometry_msgs', 'rclcpp']);
		assert.deepStrictEqual(ros2PkgCreateArgs({ name: 'ifaces', buildType: 'interface', dependencies: ['rclcpp', 'std_msgs'] }),
			['pkg', 'create', 'ifaces', '--license', 'Apache-2.0', '--build-type', 'ament_cmake', '--dependencies', 'std_msgs']);
	});

	test('effective dependencies add the client library and strip it for interfaces', () => {
		assert.deepStrictEqual(effectiveDependencies({ name: 'a', buildType: 'ament_python', dependencies: ['sensor_msgs'] }), ['sensor_msgs', 'rclpy']);
		assert.deepStrictEqual(effectiveDependencies({ name: 'a', buildType: 'interface', dependencies: ['rclpy', 'nav_msgs'] }), ['nav_msgs']);
	});

	test('offline C++ node package', () => {
		const files = generateRos2Package({ name: 'cpp_pkg', buildType: 'ament_cmake', dependencies: ['std_msgs', 'tf2_ros'] });
		assert.ok(files.get('package.xml')!.includes('<build_type>ament_cmake</build_type>'));
		assert.ok(files.get('package.xml')!.includes('<depend>tf2_ros</depend>'));
		const cmake = files.get('CMakeLists.txt')!;
		assert.ok(cmake.includes('add_executable(cpp_pkg_node src/cpp_pkg_node.cpp)'));
		assert.ok(cmake.includes('ament_target_dependencies(cpp_pkg_node std_msgs tf2_ros rclcpp)'));
		assert.ok(cmake.includes('install(DIRECTORY launch'));
		assert.ok(files.get('src/cpp_pkg_node.cpp')!.includes('class CppPkgNode : public rclcpp::Node'));
		assert.ok(files.get('launch/cpp_pkg.launch.py')!.includes(`executable='cpp_pkg_node'`));
	});

	test('offline Python node package', () => {
		const files = generateRos2Package({ name: 'py_pkg', buildType: 'ament_python', dependencies: [] });
		assert.ok(files.get('package.xml')!.includes('<build_type>ament_python</build_type>'));
		assert.ok(files.get('setup.py')!.includes(`'py_pkg_node = py_pkg.py_pkg_node:main'`));
		assert.ok(files.get('setup.py')!.includes('launch/py_pkg.launch.py'));
		assert.ok(files.has('py_pkg/__init__.py') && files.has('resource/py_pkg') && files.has('setup.cfg'));
		assert.ok(files.get('py_pkg/py_pkg_node.py')!.includes('rclpy.init'));
	});

	test('offline library and interface packages', () => {
		const lib = generateRos2Package({ name: 'lib_pkg', buildType: 'ament_cmake_library', dependencies: [] });
		assert.ok(lib.get('CMakeLists.txt')!.includes('add_library(${PROJECT_NAME} SHARED src/lib_pkg.cpp)'));
		assert.ok(lib.has('include/lib_pkg/lib_pkg.hpp'));
		assert.ok(!lib.has('launch/lib_pkg.launch.py'));
		const iface = generateRos2Package({ name: 'ifaces', buildType: 'interface', dependencies: [] });
		assert.ok(iface.get('CMakeLists.txt')!.includes('rosidl_generate_interfaces'));
		assert.ok(iface.has('msg/Status.msg') && iface.has('srv/SetMode.srv'));
		assert.ok(iface.get('package.xml')!.includes('<member_of_group>rosidl_interface_packages</member_of_group>'));
	});

	test('extras added on top of ros2 pkg create', () => {
		const extras = ros2Extras({ name: 'x', buildType: 'ament_cmake', dependencies: [] });
		assert.deepStrictEqual([...extras.keys()].sort(), ['.roboagent/package.json', 'launch/x.launch.py']);
	});
});
